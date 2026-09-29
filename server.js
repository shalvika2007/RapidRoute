const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = process.env.PORT || 5000;

/*
=========================================================
RAPIDROUTE SERVER
=========================================================

Features:
- Hospital search using OpenStreetMap / Overpass
- Nominatim fallback
- Multiple Overpass servers
- Hospital caching
- Reverse geocoding
- Static frontend serving
- CORS
- Demo fallback hospitals if external services fail

=========================================================
*/

const SEARCH_RADIUS_KM = 30;
const CACHE_TIME = 10 * 60 * 1000;

const hospitalCache = new Map();
const geocodeCache = new Map();

let lastNominatimRequest = 0;


/* ========================================================
   BASIC HELPERS
======================================================== */

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}


/* ========================================================
   DISTANCE CALCULATION
======================================================== */

function distanceKm(lat1, lon1, lat2, lon2) {

    const R = 6371;

    const dLat =
        (lat2 - lat1) * Math.PI / 180;

    const dLon =
        (lon2 - lon1) * Math.PI / 180;

    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) *
        Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) ** 2;

    return (
        R *
        2 *
        Math.atan2(
            Math.sqrt(a),
            Math.sqrt(1 - a)
        )
    );
}


/* ========================================================
   SPECIALTY MATCHING
======================================================== */

function specialtyMatches(
    name,
    address,
    specialty
) {

    if (!specialty) {
        return true;
    }

    const text =
        `${name} ${address}`.toLowerCase();

    const wanted =
        specialty.toLowerCase();

    if (wanted.includes("cardiology")) {
        return /cardio|heart|cardiac/.test(text);
    }

    if (wanted.includes("trauma")) {
        return /trauma|emergency|accident/.test(text);
    }

    if (wanted.includes("neurology")) {
        return /neuro|brain/.test(text);
    }

    if (wanted.includes("orthopedic")) {
        return /ortho|bone|joint/.test(text);
    }

    if (wanted.includes("pediatric")) {
        return /child|children|pediatric/.test(text);
    }

    if (wanted.includes("emergency")) {
        return /emergency|trauma|medical center|hospital/.test(text);
    }

    return true;
}


/* ========================================================
   HTTPS GET
======================================================== */

function httpsGet(
    url,
    headers = {},
    timeout = 20000
) {

    return new Promise((resolve, reject) => {

        const request =
            https.get(
                url,
                {
                    headers,
                    timeout
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

                                resolve({
                                    statusCode:
                                        response.statusCode,
                                    data
                                });

                                return;
                            }

                            const error =
                                new Error(
                                    `HTTP ${response.statusCode}: ${data.slice(0, 300)}`
                                );

                            error.statusCode =
                                response.statusCode;

                            reject(error);
                        }
                    );
                }
            );

        request.on(
            "timeout",
            () => {

                request.destroy(
                    new Error(
                        "Request timed out"
                    )
                );

            }
        );

        request.on(
            "error",
            reject
        );
    });
}


/* ========================================================
   NOMINATIM REQUEST
======================================================== */

async function nominatimGet(url) {

    const now =
        Date.now();

    const wait =
        1100 -
        (now - lastNominatimRequest);

    if (wait > 0) {
        await sleep(wait);
    }

    lastNominatimRequest =
        Date.now();

    const headers = {

        "User-Agent":
            "RapidRoute/1.0 Emergency Hospital Coordination Demo",

        "Accept":
            "application/json"
    };

    try {

        const result =
            await httpsGet(
                url,
                headers,
                25000
            );

        return JSON.parse(
            result.data
        );

    } catch (error) {

        if (
            error.statusCode === 429
        ) {

            console.log(
                "Nominatim rate limit reached. Retrying..."
            );

            await sleep(5000);

            lastNominatimRequest =
                Date.now();

            const retry =
                await httpsGet(
                    url,
                    headers,
                    25000
                );

            return JSON.parse(
                retry.data
            );
        }

        throw error;
    }
}


/* ========================================================
   NOMINATIM HOSPITAL SEARCH
======================================================== */

async function searchHospitalsNominatim(
    latitude,
    longitude
) {

    const radiusKm =
        SEARCH_RADIUS_KM;

    const latDelta =
        radiusKm / 111;

    const cosLat =
        Math.cos(
            latitude * Math.PI / 180
        );

    const lonDelta =
        radiusKm /
        (
            111 *
            Math.max(
                0.2,
                cosLat
            )
        );

    const left =
        longitude - lonDelta;

    const right =
        longitude + lonDelta;

    const top =
        latitude + latDelta;

    const bottom =
        latitude - latDelta;

    const params =
        new URLSearchParams({

            q: "hospital",

            format: "json",

            addressdetails: "1",

            limit: "30",

            dedupe: "1",

            bounded: "1",

            viewbox:
                `${left},${top},${right},${bottom}`
        });

    const url =
        `https://nominatim.openstreetmap.org/search?${params.toString()}`;

    return await nominatimGet(
        url
    );
}


/* ========================================================
   OVERPASS HOSPITAL SEARCH
======================================================== */

async function searchHospitalsOverpass(
    latitude,
    longitude
) {

    const radiusMeters =
        SEARCH_RADIUS_KM * 1000;

    const query = `
[out:json][timeout:25];

(
  node["amenity"="hospital"](around:${radiusMeters},${latitude},${longitude});
  way["amenity"="hospital"](around:${radiusMeters},${latitude},${longitude});
  relation["amenity"="hospital"](around:${radiusMeters},${latitude},${longitude});
);

out center tags;
`;

    const encoded =
        encodeURIComponent(
            query
        );

    const endpoints = [

        "https://overpass-api.de/api/interpreter",

        "https://overpass.kumi.systems/api/interpreter",

        "https://overpass.private.coffee/api/interpreter"
    ];

    let lastError = null;

    for (
        const endpoint of endpoints
    ) {

        try {

            console.log(
                "Trying Overpass:",
                endpoint
            );

            const result =
                await httpsGet(
                    `${endpoint}?data=${encoded}`,
                    {
                        "User-Agent":
                            "RapidRoute/1.0 Emergency Hospital Coordination Demo",

                        "Accept":
                            "application/json"
                    },
                    35000
                );

            const data =
                JSON.parse(
                    result.data
                );

            return (
                data.elements ||
                []
            );

        } catch (error) {

            console.error(
                "Overpass failed:",
                endpoint,
                error.message
            );

            lastError =
                error;
        }
    }

    throw (
        lastError ||
        new Error(
            "All Overpass servers failed"
        )
    );
}


/* ========================================================
   CONVERT OVERPASS RESULTS
======================================================== */

function convertOverpassHospitals(
    elements
) {

    const hospitals = [];

    for (
        const item of elements
    ) {

        let latitude;
        let longitude;

        if (
            item.type === "node"
        ) {

            latitude =
                Number(item.lat);

            longitude =
                Number(item.lon);

        } else if (
            item.center
        ) {

            latitude =
                Number(
                    item.center.lat
                );

            longitude =
                Number(
                    item.center.lon
                );

        } else {

            continue;
        }

        if (
            !Number.isFinite(latitude) ||
            !Number.isFinite(longitude)
        ) {

            continue;
        }

        const tags =
            item.tags || {};

        const name =
            tags.name ||
            tags["name:en"] ||
            "Hospital";

        const addressParts = [];

        if (
            tags["addr:housenumber"]
        ) {

            addressParts.push(
                tags["addr:housenumber"]
            );
        }

        if (
            tags["addr:street"]
        ) {

            addressParts.push(
                tags["addr:street"]
            );
        }

        if (
            tags["addr:city"]
        ) {

            addressParts.push(
                tags["addr:city"]
            );
        }

        const address =
            addressParts.length
                ? addressParts.join(", ")
                : "Address unavailable";

        hospitals.push({

            name,

            address,

            latitude,

            longitude
        });
    }

    return hospitals;
}


/* ========================================================
   DEMO FALLBACK
======================================================== */

function createDemoHospitals(
    latitude,
    longitude
) {

    /*
       These are NOT real hospital records.

       They are only used so the demo UI continues
       working if OpenStreetMap services temporarily fail.
    */

    return [

        {
            name:
                "Nearest Emergency Hospital",

            address:
                "Demo hospital location",

            latitude:
                latitude + 0.015,

            longitude:
                longitude + 0.010,

            demo:
                true
        },

        {
            name:
                "City Trauma Centre",

            address:
                "Demo hospital location",

            latitude:
                latitude - 0.018,

            longitude:
                longitude + 0.014,

            demo:
                true
        },

        {
            name:
                "Emergency Medical Centre",

            address:
                "Demo hospital location",

            latitude:
                latitude + 0.025,

            longitude:
                longitude - 0.018,

            demo:
                true
        },

        {
            name:
                "Regional Hospital",

            address:
                "Demo hospital location",

            latitude:
                latitude - 0.028,

            longitude:
                longitude - 0.020,

            demo:
                true
        }
    ];
}


/* ========================================================
   MAIN HOSPITAL SEARCH
======================================================== */

async function searchHospitals(
    latitude,
    longitude
) {

    const cacheKey =
        `${latitude.toFixed(3)},${longitude.toFixed(3)}`;

    const cached =
        hospitalCache.get(
            cacheKey
        );

    if (
        cached &&
        Date.now() -
        cached.timestamp <
        CACHE_TIME
    ) {

        console.log(
            "Using cached hospital data."
        );

        return cached.data;
    }


    /*
       STEP 1
       Try Overpass first.
    */

    try {

        console.log(
            "Searching hospitals using Overpass..."
        );

        const raw =
            await searchHospitalsOverpass(
                latitude,
                longitude
            );

        const converted =
            convertOverpassHospitals(
                raw
            );

        if (
            converted.length > 0
        ) {

            hospitalCache.set(
                cacheKey,
                {
                    timestamp:
                        Date.now(),

                    data:
                        converted
                }
            );

            console.log(
                `Found ${converted.length} hospitals using Overpass.`
            );

            return converted;
        }

    } catch (error) {

        console.error(
            "Overpass search failed:",
            error.message
        );
    }


    /*
       STEP 2
       Try Nominatim.
    */

    try {

        console.log(
            "Trying Nominatim hospital search..."
        );

        const results =
            await searchHospitalsNominatim(
                latitude,
                longitude
            );

        if (
            results &&
            results.length > 0
        ) {

            hospitalCache.set(
                cacheKey,
                {
                    timestamp:
                        Date.now(),

                    data:
                        results
                }
            );

            console.log(
                `Found ${results.length} hospitals using Nominatim.`
            );

            return results;
        }

    } catch (error) {

        console.error(
            "Nominatim search failed:",
            error.message
        );
    }


    /*
       STEP 3
       DEMO FALLBACK

       This prevents Page 3 from crashing.
    */

    console.warn(
        "External hospital services unavailable."
    );

    console.warn(
        "Using demo hospital locations."
    );

    const demoHospitals =
        createDemoHospitals(
            latitude,
            longitude
        );

    hospitalCache.set(
        cacheKey,
        {
            timestamp:
                Date.now(),

            data:
                demoHospitals
        }
    );

    return demoHospitals;
}


/* ========================================================
   BUILD FINAL HOSPITAL RESULTS
======================================================== */

async function fetchRealHospitals({
    latitude,
    longitude,
    specialty,
    emergency
}) {

    const results =
        await searchHospitals(
            latitude,
            longitude
        );

    const hospitals = [];


    for (
        const item of results
    ) {

        const lat =
            Number(
                item.lat ??
                item.latitude
            );

        const lon =
            Number(
                item.lon ??
                item.longitude
            );

        if (
            !Number.isFinite(lat) ||
            !Number.isFinite(lon)
        ) {

            continue;
        }


        const distance =
            distanceKm(
                latitude,
                longitude,
                lat,
                lon
            );


        if (
            distance >
            SEARCH_RADIUS_KM
        ) {

            continue;
        }


        const name =
            item.name ||
            item.display_name?.split(",")[0] ||
            "Hospital";


        const address =
            item.display_name ||
            item.address ||
            "Address unavailable";


        const specialtyMatch =
            specialtyMatches(
                name,
                address,
                specialty
            );


        /*
           Estimated ETA.

           This is NOT live traffic data.
        */

        const estimatedMinutes =
            Math.max(
                3,
                Math.round(
                    distance * 3
                )
            );


        let matchScore = 70;


        if (
            specialty &&
            specialtyMatch
        ) {

            matchScore += 20;
        }


        if (
            distance < 5
        ) {

            matchScore += 10;

        } else if (
            distance < 10
        ) {

            matchScore += 7;

        } else if (
            distance < 20
        ) {

            matchScore += 4;
        }


        matchScore =
            Math.min(
                99,
                matchScore
            );


        hospitals.push({

            name,

            address,

            latitude:
                lat,

            longitude:
                lon,

            distance:
                Number(
                    distance.toFixed(1)
                ),

            eta:
                estimatedMinutes,

            estimatedMinutes,

            matchScore,

            specialty:
                specialtyMatch &&
                specialty
                    ? [specialty]
                    : ["Hospital"],

            source:
                item.demo
                    ? "RapidRoute Demo"
                    : "OpenStreetMap",

            demo:
                Boolean(
                    item.demo
                )
        });
    }


    /* ====================================================
       REMOVE DUPLICATES
    ==================================================== */

    const unique = [];

    const seen =
        new Set();


    for (
        const hospital of hospitals
    ) {

        const key =
            `${hospital.name.toLowerCase()}|` +
            `${hospital.latitude.toFixed(5)}|` +
            `${hospital.longitude.toFixed(5)}`;


        if (
            !seen.has(key)
        ) {

            seen.add(key);

            unique.push(
                hospital
            );
        }
    }


    /* ====================================================
       SORT
    ==================================================== */

    unique.sort(
        (a, b) => {

            const aSpecialty =
                specialtyMatches(
                    a.name,
                    a.address,
                    specialty
                );

            const bSpecialty =
                specialtyMatches(
                    b.name,
                    b.address,
                    specialty
                );


            if (
                aSpecialty !==
                bSpecialty
            ) {

                return (
                    Number(bSpecialty) -
                    Number(aSpecialty)
                );
            }


            return (
                a.distance -
                b.distance
            );
        }
    );


    return unique;
}


/* ========================================================
   REVERSE GEOCODING
======================================================== */

async function reverseGeocode(
    latitude,
    longitude
) {

    const cacheKey =
        `${latitude.toFixed(4)},${longitude.toFixed(4)}`;


    const cached =
        geocodeCache.get(
            cacheKey
        );


    if (
        cached &&
        Date.now() -
        cached.timestamp <
        CACHE_TIME
    ) {

        return cached.data;
    }


    const params =
        new URLSearchParams({

            lat:
                latitude,

            lon:
                longitude,

            format:
                "json",

            zoom:
                "18",

            addressdetails:
                "1"
        });


    const url =
        `https://nominatim.openstreetmap.org/reverse?${params.toString()}`;


    try {

        const result =
            await nominatimGet(
                url
            );


        geocodeCache.set(
            cacheKey,
            {
                timestamp:
                    Date.now(),

                data:
                    result
            }
        );


        return result;

    } catch (error) {

        console.error(
            "Reverse geocoding failed:",
            error.message
        );


        return {

            display_name:
                "Current location"
        };
    }
}


/* ========================================================
   JSON RESPONSE
======================================================== */

function sendJson(
    response,
    statusCode,
    data
) {

    const body =
        JSON.stringify(
            data
        );


    response.writeHead(
        statusCode,
        {

            "Content-Type":
                "application/json",

            "Access-Control-Allow-Origin":
                "*",

            "Access-Control-Allow-Methods":
                "GET,POST,OPTIONS",

            "Access-Control-Allow-Headers":
                "Content-Type"
        }
    );


    response.end(
        body
    );
}


/* ========================================================
   STATIC FILE SERVER
======================================================== */

function serveStatic(
    response,
    pathname
) {

    let filePath;


    if (
        pathname === "/" ||
        pathname === ""
    ) {

        filePath =
            path.join(
                __dirname,
                "public",
                "index.html"
            );

    } else {

        const cleanPath =
            pathname.replace(
                /^\/+/,
                ""
            );


        filePath =
            path.join(
                __dirname,
                "public",
                cleanPath
            );
    }


    const publicFolder =
        path.join(
            __dirname,
            "public"
        );


    const normalizedPath =
        path.normalize(
            filePath
        );


    if (
        !normalizedPath.startsWith(
            publicFolder
        )
    ) {

        response.writeHead(
            403
        );

        response.end(
            "Forbidden"
        );

        return;
    }


    fs.readFile(
        normalizedPath,
        (
            error,
            data
        ) => {

            if (
                error
            ) {

                response.writeHead(
                    404
                );

                response.end(
                    "Not found"
                );

                return;
            }


            const ext =
                path.extname(
                    normalizedPath
                );


            const types = {

                ".html":
                    "text/html; charset=utf-8",

                ".css":
                    "text/css; charset=utf-8",

                ".js":
                    "application/javascript; charset=utf-8",

                ".jpg":
                    "image/jpeg",

                ".jpeg":
                    "image/jpeg",

                ".png":
                    "image/png",

                ".webp":
                    "image/webp",

                ".svg":
                    "image/svg+xml",

                ".ico":
                    "image/x-icon"
            };


            response.writeHead(
                200,
                {

                    "Content-Type":
                        types[ext] ||
                        "application/octet-stream"
                }
            );


            response.end(
                data
            );
        }
    );
}


/* ========================================================
   SERVER
======================================================== */

const server =
    http.createServer(
        async (
            request,
            response
        ) => {

            /*
            -----------------------------------------------
            CORS PREFLIGHT
            -----------------------------------------------
            */

            if (
                request.method ===
                "OPTIONS"
            ) {

                response.writeHead(
                    204,
                    {

                        "Access-Control-Allow-Origin":
                            "*",

                        "Access-Control-Allow-Methods":
                            "GET,POST,OPTIONS",

                        "Access-Control-Allow-Headers":
                            "Content-Type"
                    }
                );


                response.end();

                return;
            }


            try {

                const parsedUrl =
                    new URL(
                        request.url,
                        `http://${request.headers.host}`
                    );


                const pathname =
                    parsedUrl.pathname;


                /*
                -------------------------------------------
                HEALTH CHECK
                -------------------------------------------
                */

                if (
                    request.method === "GET" &&
                    pathname ===
                        "/api/health"
                ) {

                    sendJson(
                        response,
                        200,
                        {

                            status:
                                "ok",

                            service:
                                "RapidRoute",

                            hospitalData:
                                "OpenStreetMap / Overpass / Nominatim with demo fallback",

                            searchRadiusKm:
                                SEARCH_RADIUS_KM
                        }
                    );

                    return;
                }


                /*
                -------------------------------------------
                REVERSE GEOCODE
                -------------------------------------------
                */

                if (
                    request.method === "GET" &&
                    pathname ===
                        "/reverse-geocode"
                ) {

                    const latitude =
                        Number(
                            parsedUrl
                                .searchParams
                                .get("lat")
                        );


                    const longitude =
                        Number(
                            parsedUrl
                                .searchParams
                                .get("lon")
                        );


                    if (
                        !Number.isFinite(
                            latitude
                        ) ||
                        !Number.isFinite(
                            longitude
                        )
                    ) {

                        sendJson(
                            response,
                            400,
                            {

                                error:
                                    "Invalid coordinates"
                            }
                        );

                        return;
                    }


                    const result =
                        await reverseGeocode(
                            latitude,
                            longitude
                        );


                    sendJson(
                        response,
                        200,
                        {

                            display_name:
                                result.display_name ||
                                "Current location"
                        }
                    );


                    return;
                }


                /*
                -------------------------------------------
                FIND HOSPITAL
                -------------------------------------------
                */

                if (
                    request.method === "POST" &&
                    pathname ===
                        "/find-hospital"
                ) {

                    let body = "";


                    request.on(
                        "data",
                        chunk => {

                            body += chunk;


                            if (
                                body.length >
                                100000
                            ) {

                                request.destroy();
                            }
                        }
                    );


                    request.on(
                        "end",
                        async () => {

                            try {

                                const input =
                                    JSON.parse(
                                        body ||
                                        "{}"
                                    );


                                const latitude =
                                    Number(
                                        input.latitude
                                    );


                                const longitude =
                                    Number(
                                        input.longitude
                                    );


                                const specialty =
                                    String(
                                        input.specialty ||
                                        ""
                                    );


                                const emergency =
                                    String(
                                        input.emergency ||
                                        ""
                                    );


                                if (
                                    !Number.isFinite(
                                        latitude
                                    ) ||
                                    !Number.isFinite(
                                        longitude
                                    )
                                ) {

                                    sendJson(
                                        response,
                                        400,
                                        {

                                            error:
                                                "Valid latitude and longitude are required"
                                        }
                                    );

                                    return;
                                }


                                console.log(
                                    "Hospital search:",
                                    {

                                        latitude,

                                        longitude,

                                        specialty,

                                        emergency
                                    }
                                );


                                const hospitals =
                                    await fetchRealHospitals(
                                        {

                                            latitude,

                                            longitude,

                                            specialty,

                                            emergency
                                        }
                                    );


                                sendJson(
                                    response,
                                    200,
                                    {

                                        ambulanceLocation:
                                            {

                                                latitude,

                                                longitude
                                            },

                                        emergencyType:
                                            emergency,

                                        specialty,

                                        totalFound:
                                            hospitals.length,

                                        hospitals
                                    }
                                );

                            } catch (
                                error
                            ) {

                                console.error(
                                    "Hospital search error:",
                                    error
                                );


                                sendJson(
                                    response,
                                    500,
                                    {

                                        error:
                                            "Hospital search failed",

                                        details:
                                            error.message
                                    }
                                );
                            }
                        }
                    );


                    return;
                }


                /*
                -------------------------------------------
                STATIC WEBSITE
                -------------------------------------------
                */

                serveStatic(
                    response,
                    pathname
                );

            } catch (
                error
            ) {

                console.error(
                    "Server error:",
                    error
                );


                sendJson(
                    response,
                    500,
                    {

                        error:
                            "Server error"
                    }
                );
            }
        }
    );


/* ========================================================
   START SERVER
======================================================== */

server.listen(
    PORT,
    () => {

        console.log(
            `RapidRoute server running on port ${PORT}`
        );

        console.log(
            `Hospital search radius: ${SEARCH_RADIUS_KM} km`
        );
    }
);
