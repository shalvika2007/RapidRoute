const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = process.env.PORT || 5000;
const SEARCH_RADIUS_KM = 100;

/* =========================================================
SIMPLE IN-MEMORY CACHE
========================================================= */

const hospitalCache = new Map();
const geocodeCache = new Map();

const CACHE_TIME = 10 * 60 * 1000; // 10 minutes

let lastNominatimRequest = 0;

function sleep(ms) {
return new Promise(resolve => setTimeout(resolve, ms));
}

/* =========================================================
DISTANCE
========================================================= */

function distanceKm(lat1, lon1, lat2, lon2) {
const R = 6371;

const dLat = (lat2 - lat1) * Math.PI / 180;  
const dLon = (lon2 - lon1) * Math.PI / 180;  

const a =  
    Math.sin(dLat / 2) ** 2 +  
    Math.cos(lat1 * Math.PI / 180) *  
    Math.cos(lat2 * Math.PI / 180) *  
    Math.sin(dLon / 2) ** 2;  

return R * 2 *  
    Math.atan2(  
        Math.sqrt(a),  
        Math.sqrt(1 - a)  
    );

}

/* =========================================================
SPECIALTY MATCHING
========================================================= */

function specialtyMatches(name, address, specialty) {

if (!specialty) {  
    return true;  
}  

const text =  
    `${name} ${address}`.toLowerCase();  

const wanted =  
    specialty.toLowerCase();  

if (wanted.includes("cardiology")) {  
    return /cardio|heart/.test(text);  
}  

if (wanted.includes("trauma")) {  
    return /trauma|emergency|accident/.test(text);  
}  

if (wanted.includes("neurology")) {  
    return /neuro|brain/.test(text);  
}  

if (wanted.includes("emergency")) {  
    return /emergency|trauma|medical center|hospital/.test(text);  
}  

return true;

}

/* =========================================================
BOUNDING BOX
========================================================= */

function createBoundingBox(
latitude,
longitude,
radiusKm
) {

const latDelta =  
    radiusKm / 111;  

const cosLat =  
    Math.cos(latitude * Math.PI / 180);  

const lonDelta =  
    radiusKm /  
    (111 * Math.max(0.2, cosLat));  

return {  
    left: longitude - lonDelta,  
    right: longitude + lonDelta,  
    top: latitude + latDelta,  
    bottom: latitude - latDelta  
};

}

/* =========================================================
HTTPS GET
========================================================= */

function httpsGet(url, headers = {}) {

return new Promise((resolve, reject) => {  

    const request = https.get(  
        url,  
        {  
            headers,  
            timeout: 25000  
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

/* =========================================================
NOMINATIM REQUEST
========================================================= */

async function nominatimGet(url) {

/*  
   Nominatim asks clients to avoid rapid requests.  
   We therefore make sure there is a small gap  
   between requests.  
*/  

const now = Date.now();  

const wait =  
    1100 -  
    (now - lastNominatimRequest);  

if (wait > 0) {  
    await sleep(wait);  
}  

lastNominatimRequest =  
    Date.now();  

try {  

    const result =  
        await httpsGet(  
            url,  
            {  
                "User-Agent":  
                    "RapidRoute/1.0 Emergency Hospital Coordination Demo"  
            }  
        );  

    return JSON.parse(  
        result.data  
    );  

} catch (error) {  

    /*  
       If Nominatim temporarily returns 429,  
       wait and try once more.  
    */  

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
                {  
                    "User-Agent":  
                        "RapidRoute/1.0 Emergency Hospital Coordination Demo"  
                }  
            );  

        return JSON.parse(  
            retry.data  
        );  
    }  

    throw error;  
}

}

/* =========================================================
NOMINATIM HOSPITAL SEARCH
========================================================= */

async function searchHospitalsNominatim(
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
            `${box.left},${box.top},${box.right},${box.bottom}`  
    });  

const url =  
    `https://nominatim.openstreetmap.org/search?${params.toString()}`;  

return await nominatimGet(url);

}

/* =========================================================
OVERPASS FALLBACK
========================================================= */

async function searchHospitalsOverpass(
latitude,
longitude
) {

/*  
   Overpass is used only when Nominatim  
   is temporarily unavailable.  

   We use a smaller practical radius for  
   the fallback to avoid an unnecessarily  
   heavy query.  
*/  

const radiusMeters =  
    Math.min(  
        SEARCH_RADIUS_KM * 1000,  
        100000  
    );  

const query = `

[out:json][timeout:30];

(
node"amenity"="hospital";
way"amenity"="hospital";
relation"amenity"="hospital";
);

out center tags;
`;

const encoded =  
    encodeURIComponent(query);  

const endpoints = [  
    "https://overpass-api.de/api/interpreter",  
    "https://overpass.kumi.systems/api/interpreter"  
];  

let lastError = null;  

for (const endpoint of endpoints) {  

    try {  

        const result =  
            await httpsGet(  
                `${endpoint}?data=${encoded}`,  
                {  
                    "User-Agent":  
                        "RapidRoute/1.0 Emergency Hospital Coordination Demo"  
                }  
            );  

        const data =  
            JSON.parse(result.data);  

        return data.elements || [];  

    } catch (error) {  

        console.error(  
            "Overpass endpoint failed:",  
            endpoint,  
            error.message  
        );  

        lastError = error;  
    }  
}  

throw lastError ||  
    new Error(  
        "Hospital data services unavailable"  
    );

}

/* =========================================================
CONVERT OVERPASS RESULT
========================================================= */

function convertOverpassHospitals(
elements
) {

const hospitals = [];  

for (const item of elements) {  

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
            Number(item.center.lat);  

        longitude =  
            Number(item.center.lon);  

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

    if (tags["addr:housenumber"]) {  
        addressParts.push(  
            tags["addr:housenumber"]  
        );  
    }  

    if (tags["addr:street"]) {  
        addressParts.push(  
            tags["addr:street"]  
        );  
    }  

    if (tags["addr:city"]) {  
        addressParts.push(  
            tags["addr:city"]  
        );  
    }  

    const address =  
        addressParts.length > 0  
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

/* =========================================================
MAIN REAL HOSPITAL SEARCH
========================================================= */

async function searchHospitals(
latitude,
longitude
) {

/*  
   Round the location so that tiny GPS changes  
   still use the same cache entry.  
*/  

const cacheKey =  
    `${latitude.toFixed(3)},${longitude.toFixed(3)}`;  

const cached =  
    hospitalCache.get(cacheKey);  

if (  
    cached &&  
    Date.now() - cached.timestamp <  
        CACHE_TIME  
) {  

    console.log(  
        "Using cached hospital data."  
    );  

    return cached.data;  
}  

let results = [];  

try {  

    console.log(  
        "Searching hospitals using Nominatim..."  
    );  

    results =  
        await searchHospitalsNominatim(  
            latitude,  
            longitude  
        );  

} catch (error) {  

    console.error(  
        "Nominatim hospital search failed:",  
        error.message  
    );  

    console.log(  
        "Trying Overpass fallback..."  
    );  

    try {  

        results =  
            await searchHospitalsOverpass(  
                latitude,  
                longitude  
            );  

        results =  
            convertOverpassHospitals(  
                results  
            );  

    } catch (fallbackError) {  

        console.error(  
            "Overpass fallback failed:",  
            fallbackError.message  
        );  

        throw new Error(  
            "Real hospital data services are temporarily unavailable."  
        );  
    }  
}  

hospitalCache.set(  
    cacheKey,  
    {  
        timestamp: Date.now(),  
        data: results  
    }  
);  

return results;

}

/* =========================================================
BUILD HOSPITAL RESULTS
========================================================= */

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

for (const item of results) {  

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
       This is an estimated travel time,  
       not live ambulance navigation time.  
    */  

    const estimatedMinutes =  
        Math.max(  
            3,  
            Math.round(distance * 3)  
        );  

    let matchScore = 70;  

    if (  
        specialty &&  
        specialtyMatch  
    ) {  
        matchScore += 20;  
    }  

    if (distance < 10) {  
        matchScore += 10;  
    } else if (distance < 25) {  
        matchScore += 5;  
    }  

    matchScore =  
        Math.min(  
            99,  
            matchScore  
        );  

    hospitals.push({  
        name,  
        address,  
        latitude: lat,  
        longitude: lon,  
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
            "OpenStreetMap"  
    });  
}  

/* =====================================================  
   REMOVE DUPLICATES  
   ===================================================== */  

const unique = [];  
const seen = new Set();  

for (const hospital of hospitals) {  

    const key =  
        `${hospital.name.toLowerCase()}|` +  
        `${hospital.latitude.toFixed(5)}|` +  
        `${hospital.longitude.toFixed(5)}`;  

    if (!seen.has(key)) {  

        seen.add(key);  
        unique.push(hospital);  
    }  
}  

/* =====================================================  
   SORT  
   ===================================================== */  

unique.sort((a, b) => {  

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
        return bSpecialty -  
            aSpecialty;  
    }  

    return a.distance -  
        b.distance;  
});  

return unique;

}

/* =========================================================
REVERSE GEOCODING
========================================================= */

async function reverseGeocode(
latitude,
longitude
) {

const cacheKey =  
    `${latitude.toFixed(4)},${longitude.toFixed(4)}`;  

const cached =  
    geocodeCache.get(cacheKey);  

if (  
    cached &&  
    Date.now() - cached.timestamp <  
        CACHE_TIME  
) {  

    return cached.data;  
}  

const params =  
    new URLSearchParams({  
        lat: latitude,  
        lon: longitude,  
        format: "json",  
        zoom: "18",  
        addressdetails: "1"  
    });  

const url =  
    `https://nominatim.openstreetmap.org/reverse?${params.toString()}`;  

const result =  
    await nominatimGet(url);  

geocodeCache.set(  
    cacheKey,  
    {  
        timestamp: Date.now(),  
        data: result  
    }  
);  

return result;

}

/* =========================================================
JSON RESPONSE
========================================================= */

function sendJson(
response,
statusCode,
data
) {

const body =  
    JSON.stringify(data);  

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

response.end(body);

}

/* =========================================================
STATIC FILES
========================================================= */

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

    response.writeHead(403);  
    response.end(  
        "Forbidden"  
    );  

    return;  
}  

fs.readFile(  
    normalizedPath,  
    (error, data) => {  

        if (error) {  

            response.writeHead(404);  

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
                "image/svg+xml"  
        };  

        response.writeHead(  
            200,  
            {  
                "Content-Type":  
                    types[ext] ||  
                    "application/octet-stream"  
            }  
        );  

        response.end(data);  
    }  
);

}

/* =========================================================
SERVER
========================================================= */

const server =
http.createServer(
async (
request,
response
) => {

/* ---------------------------------------------  
           CORS PREFLIGHT  
        --------------------------------------------- */  

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

            /* -----------------------------------------  
               HEALTH CHECK  
            ----------------------------------------- */  

            if (  
                request.method === "GET" &&  
                pathname === "/api/health"  
            ) {  

                sendJson(  
                    response,  
                    200,  
                    {  
                        status: "ok",  
                   
