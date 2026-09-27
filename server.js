const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");


/* =========================================================
   RAPIDROUTE SERVER
========================================================= */

const PORT = process.env.PORT || 5000;

const SEARCH_RADIUS_KM = 100;


/* =========================================================
   BASIC HELPERS
========================================================= */

function sendJSON(res, statusCode, data) {

    res.writeHead(statusCode, {

        "Content-Type": "application/json",

        "Access-Control-Allow-Origin": "*",

        "Access-Control-Allow-Methods":
            "GET, POST, OPTIONS",

        "Access-Control-Allow-Headers":
            "Content-Type"

    });

    res.end(
        JSON.stringify(data)
    );

}


function sendText(res, statusCode, text) {

    res.writeHead(statusCode, {

        "Content-Type": "text/plain",

        "Access-Control-Allow-Origin": "*"

    });

    res.end(text);

}


/* =========================================================
   DISTANCE CALCULATION
========================================================= */

function distance(
    lat1,
    lon1,
    lat2,
    lon2
) {

    const R = 6371;

    const dLat =
        (lat2 - lat1) *
        Math.PI /
        180;

    const dLon =
        (lon2 - lon1) *
        Math.PI /
        180;


    const a =
        Math.sin(dLat / 2) *
        Math.sin(dLat / 2) +

        Math.cos(
            lat1 *
            Math.PI /
            180
        ) *

        Math.cos(
            lat2 *
            Math.PI /
            180
        ) *

        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);


    const c =
        2 *
        Math.atan2(
            Math.sqrt(a),
            Math.sqrt(1 - a)
        );


    return R * c;

}



/* =========================================================
   SPECIALTY MATCHING
========================================================= */

function specialtyMatches(
    hospital,
    specialty
) {

    if (!specialty) {

        return true;

    }


    const text = (

        (hospital.name || "") +
        " " +
        (hospital.type || "") +
        " " +
        (hospital.specialty || "") +
        " " +
        (hospital.display_name || "")

    ).toLowerCase();


    const requested =
        specialty.toLowerCase();


    const aliases = {

        "cardiology": [
            "cardiology",
            "cardiac",
            "heart",
            "cardiovascular"
        ],

        "trauma care": [
            "trauma",
            "accident",
            "orthopedic",
            "orthopaedic"
        ],

        "neurology": [
            "neurology",
            "neuro",
            "brain",
            "stroke"
        ],

        "emergency medicine": [
            "emergency",
            "trauma",
            "accident",
            "medical center",
            "medical centre",
            "hospital"
        ]

    };


    const keywords =
        aliases[requested] ||
        [requested];


    return keywords.some(
        keyword =>
            text.includes(keyword)
    );

}



/* =========================================================
   CREATE 100 KM BOUNDING BOX
========================================================= */

function createBoundingBox(
    latitude,
    longitude,
    radiusKm
) {

    const latDelta =
        radiusKm / 111;


    const longitudeFactor =
        Math.cos(
            latitude *
            Math.PI /
            180
        );


    const lonDelta =
        radiusKm /
        (111 *
            Math.max(
                longitudeFactor,
                0.1
            ));


    return {

        south:
            latitude - latDelta,

        north:
            latitude + latDelta,

        west:
            longitude - lonDelta,

        east:
            longitude + lonDelta

    };

}



/* =========================================================
   HTTPS GET HELPER
========================================================= */

function httpsGet(
    url,
    headers = {}
) {

    return new Promise(
        (resolve, reject) => {

            const request =
                https.get(
                    url,
                    {
                        headers
                    },
                    response => {

                        let data = "";


                        response.on(
                            "data",
                            chunk => {

                                data += chunk;

                            }
                        );


                        response.on(
                            "end",
                            () => {

                                if (
                                    response.statusCode >= 200 &&
                                    response.statusCode < 300
                                ) {

                                    resolve(data);

                                }

                                else {

                                    reject(
                                        new Error(
                                            `HTTP ${response.statusCode}`
                                        )
                                    );

                                }

                            }
                        );

                    }
                );


            request.on(
                "error",
                reject
            );


            request.setTimeout(
                20000,
                () => {

                    request.destroy();

                    reject(
                        new Error(
                            "Request timed out"
                        )
                    );

                }
            );

        }
    );

}



/* =========================================================
   SEARCH HOSPITALS USING NOMINATIM
========================================================= */

async function searchHospitals(
    latitude,
    longitude
) {

    const box =
        createBoundingBox(
            latitude,
            longitude,
            SEARCH_RADIUS_KM
        );


    const params =
        new URLSearchParams({

            q: "hospital",

            format: "json",

            addressdetails: "1",

            limit: "50",

            dedupe: "1",

            bounded: "1",

            viewbox:
                `${box.west},${box.north},${box.east},${box.south}`

        });


    const url =
        "https://nominatim.openstreetmap.org/search?" +
        params.toString();


    const raw =
        await httpsGet(
            url,
            {

                "User-Agent":
                    "RapidRoute Emergency Coordination Prototype/1.0",

                "Accept":
                    "application/json"

            }
        );


    return JSON.parse(raw);

}



/* =========================================================
   FETCH REAL HOSPITALS
========================================================= */

async function fetchRealHospitals(
    latitude,
    longitude,
    specialty
) {

    const results =
        await searchHospitals(
            latitude,
            longitude
        );


    const hospitals = [];


    for (
        const item of results
    ) {

        const hospitalLatitude =
            Number(
                item.lat
            );


        const hospitalLongitude =
            Number(
                item.lon
            );


        if (
            !Number.isFinite(
                hospitalLatitude
            ) ||
            !Number.isFinite(
                hospitalLongitude
            )
        ) {

            continue;

        }


        const km =
            distance(
                latitude,
                longitude,
                hospitalLatitude,
                hospitalLongitude
            );


        /*
         * Extra safety filter.
         * Only keep hospitals actually
         * within 100 km.
         */

        if (
            km > SEARCH_RADIUS_KM
        ) {

            continue;

        }


        const hospital = {

            name:
                item.name ||
                "Hospital",

            latitude:
                hospitalLatitude,

            longitude:
                hospitalLongitude,

            distanceKm:
                Number(
                    km.toFixed(2)
                ),

            address:
                item.display_name ||
                "Address unavailable",

            display_name:
                item.display_name ||
                "",

            type:
                item.type ||
                "hospital",

            specialty:
                "",

            source:
                "OpenStreetMap"

        };


        hospital.specialtyMatch =
            specialtyMatches(
                hospital,
                specialty
            );


        /*
         * Simple estimated arrival.
         *
         * This is NOT live traffic.
         * It is a distance-based estimate.
         */

        hospital.estimatedMinutes =
            Math.max(
                3,
                Math.round(
                    km * 3
                )
            );


        hospitals.push(
            hospital
        );

    }


    /*
     * Remove duplicate hospitals.
     */

    const uniqueHospitals =
        new Map();


    for (
        const hospital of hospitals
    ) {

        const key =
            (
                hospital.name +
                "|" +
                hospital.latitude.toFixed(5) +
                "|" +
                hospital.longitude.toFixed(5)
            ).toLowerCase();


        if (
            !uniqueHospitals.has(
                key
            )
        ) {

            uniqueHospitals.set(
                key,
                hospital
            );

        }

    }


    /*
     * Sort:
     *
     * 1. Specialty match
     * 2. Nearest distance
     */

    const finalHospitals =
        Array.from(
            uniqueHospitals.values()
        );


    finalHospitals.sort(
        (
            a,
            b
        ) => {

            if (
                a.specialtyMatch !==
                b.specialtyMatch
            ) {

                return a.specialtyMatch
                    ? -1
                    : 1;

            }


            return (
                a.distanceKm -
                b.distanceKm
            );

        }
    );


    /*
     * Return the actual hospitals
     * found by the backend.
     */

    return finalHospitals;

}



/* =========================================================
   REVERSE GEOCODING
========================================================= */

async function reverseGeocode(
    latitude,
    longitude
) {

    const params =
        new URLSearchParams({

            lat:
                latitude,

            lon:
                longitude,

            format:
                "json",

            addressdetails:
                "1"

        });


    const url =
        "https://nominatim.openstreetmap.org/reverse?" +
        params.toString();


    const raw =
        await httpsGet(
            url,
            {

                "User-Agent":
                    "RapidRoute Emergency Coordination Prototype/1.0",

                "Accept":
                    "application/json"

            }
        );


    return JSON.parse(
        raw
    );

}



/* =========================================================
   READ REQUEST BODY
========================================================= */

function getRequestBody(
    req
) {

    return new Promise(
        (resolve, reject) => {

            let body = "";


            req.on(
                "data",
                chunk => {

                    body += chunk;

                }
            );


            req.on(
                "end",
                () => {

                    try {

                        resolve(
                            body
                                ? JSON.parse(body)
                                : {}
                        );

                    }

                    catch (error) {

                        reject(
                            error
                        );

                    }

                }
            );


            req.on(
                "error",
                reject
            );

        }
    );

}



/* =========================================================
   STATIC FILE SERVER
========================================================= */

function serveStaticFile(
    req,
    res
) {

    let requestedPath =
        req.url.split("?")[0];


    if (
        requestedPath === "/"
    ) {

        requestedPath =
            "/index.html";

    }


    /*
     * Prevent directory traversal.
     */

    const safePath =
        path.normalize(
            requestedPath
        )
        .replace(
            /^(\.\.[\/\\])+/,
            ""
        );


    const filePath =
        path.join(
            __dirname,
            "public",
            safePath
        );


    /*
     * Check that file remains inside
     * the public directory.
     */

    const publicDirectory =
        path.resolve(
            __dirname,
            "public"
        );


    const resolvedFile =
        path.resolve(
            filePath
        );


    if (
        !resolvedFile.startsWith(
            publicDirectory
        )
    ) {

        sendText(
            res,
            403,
            "Forbidden"
        );

        return;

    }


    fs.readFile(
        resolvedFile,
        (error, data) => {

            if (error) {

                sendText(
                    res,
                    404,
                    "File not found"
                );

                return;

            }


            const extension =
                path.extname(
                    resolvedFile
                ).toLowerCase();


            const contentTypes = {

                ".html":
                    "text/html; charset=utf-8",

                ".css":
                    "text/css; charset=utf-8",

                ".js":
                    "application/javascript; charset=utf-8",

                ".json":
                    "application/json; charset=utf-8",

                ".jpg":
                    "image/jpeg",

                ".jpeg":
                    "image/jpeg",

                ".png":
                    "image/png",

                ".webp":
                    "image/webp",

                ".svg":
                    "image/svg+xml"

            };


            const contentType =
                contentTypes[extension] ||
                "application/octet-stream";


            res.writeHead(
                200,
                {

                    "Content-Type":
                        contentType,

                    "Access-Control-Allow-Origin":
                        "*"

                }
            );


            res.end(
                data
            );

        }
    );

}



/* =========================================================
   CREATE SERVER
========================================================= */

const server =
    http.createServer(
        async (
            req,
            res
        ) => {

            /*
             * CORS preflight
             */

            if (
                req.method ===
                "OPTIONS"
            ) {

                res.writeHead(
                    204,
                    {

                        "Access-Control-Allow-Origin":
                            "*",

                        "Access-Control-Allow-Methods":
                            "GET, POST, OPTIONS",

                        "Access-Control-Allow-Headers":
                            "Content-Type"

                    }
                );


                res.end();

                return;

            }


            try {

                const requestUrl =
                    new URL(
                        req.url,
                        `http://${req.headers.host}`
                    );


                /* =========================================
                   HEALTH CHECK
                ========================================= */

                if (
                    requestUrl.pathname ===
                    "/api/health"
                ) {

                    sendJSON(
                        res,
                        200,
                        {

                            status:
                                "ok",

                            message:
                                "RapidRoute backend is running",

                            hospitalData:
                                "OpenStreetMap / Nominatim",

                            searchRadius:
                                SEARCH_RADIUS_KM,

                            googleMaps:
                                "Frontend only"

                        }
                    );

                    return;

                }


                /* =========================================
                   REVERSE GEOCODING
                ========================================= */

                if (
                    requestUrl.pathname ===
                    "/reverse-geocode"
                ) {

                    const latitude =
                        Number(
                            requestUrl.searchParams.get(
                                "lat"
                            )
                        );


                    const longitude =
                        Number(
                            requestUrl.searchParams.get(
                                "lon"
                            )
                        );


                    if (
                        !Number.isFinite(
                            latitude
                        ) ||
                        !Number.isFinite(
                            longitude
                        )
                    ) {

                        sendJSON(
                            res,
                            400,
                            {

                                error:
                                    "Valid latitude and longitude are required."

                            }
                        );

                        return;

                    }


                    const result =
                        await reverseGeocode(
                            latitude,
                            longitude
                        );


                    sendJSON(
                        res,
                        200,
                        {

                            display_name:
                                result.display_name ||
                                "",

                            address:
                                result.address ||
                                {},

                            latitude:
                                latitude,

                            longitude:
                                longitude

                        }
                    );


                    return;

                }


                /* =========================================
                   FIND HOSPITAL
                ========================================= */

                if (
                    requestUrl.pathname ===
                        "/find-hospital" &&
                    req.method ===
                        "POST"
                ) {

                    const body =
                        await getRequestBody(
                            req
                        );


                    const latitude =
                        Number(
                            body.latitude
                        );


                    const longitude =
                        Number(
                            body.longitude
                        );


                    const emergencyType =
                        body.emergencyType ||
                        "";


                    const specialty =
                        body.specialty ||
                        "";


                    if (
                        !Number.isFinite(
                            latitude
                        ) ||
                        !Number.isFinite(
                            longitude
                        )
                    ) {

                        sendJSON(
                            res,
                            400,
                            {

                                error:
                                    "Valid ambulance latitude and longitude are required."

                            }
                        );

                        return;

                    }


                    console.log(
                        "Hospital search:",
                        {

                            latitude,
                            longitude,

                            emergencyType,
                            specialty

                        }
                    );


                    const hospitals =
                        await fetchRealHospitals(
                            latitude,
                            longitude,
                            specialty
                        );


                    /*
                     * Send real hospital coordinates
                     * to the frontend.
                     *
                     * Google Maps uses these coordinates
                     * to place its markers.
                     */

                    sendJSON(
                        res,
                        200,
                        {

                            success:
                                true,

                            source:
                                "OpenStreetMap",

                            searchRadiusKm:
                                SEARCH_RADIUS_KM,

                            ambulanceLocation: {

                                latitude:
                                    latitude,

                                longitude:
                                    longitude

                            },

                            emergencyType:
                                emergencyType,

                            specialty:
                                specialty,

                            totalFound:
                                hospitals.length,

                            hospitals:
                                hospitals

                        }
                    );


                    return;

                }


                /* =========================================
                   STATIC FRONTEND
                ========================================= */

                serveStaticFile(
                    req,
                    res
                );

            }

            catch (error) {

                console.error(
                    "Server error:",
                    error
                );


                sendJSON(
                    res,
                    500,
                    {

                        success:
                            false,

                        error:
                            "Internal server error",

                        message:
                            error.message

                    }
                );

            }

        }
    );



/* =========================================================
   START SERVER
========================================================= */

server.listen(
    PORT,
    () => {

        console.log(
            `RapidRoute server running on port ${PORT}`
        );

        console.log(
            `Hospital search radius: ${SEARCH_RADIUS_KM} km`
        );

        console.log(
            "Hospital data source: OpenStreetMap / Nominatim"
        );

    }
);
