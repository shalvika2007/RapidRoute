const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = process.env.PORT || 5000;
const SEARCH_RADIUS_KM = 100;

function distanceKm(lat1, lon1, lat2, lon2) {
    const R = 6371;

    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;

    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) *
        Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) ** 2;

    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function specialtyMatches(name, address, specialty) {
    if (!specialty) return true;

    const text = `${name} ${address}`.toLowerCase();

    if (specialty.toLowerCase().includes("cardiology")) {
        return /cardio|heart/.test(text);
    }

    if (specialty.toLowerCase().includes("trauma")) {
        return /trauma|emergency|accident/.test(text);
    }

    if (specialty.toLowerCase().includes("neurology")) {
        return /neuro|brain/.test(text);
    }

    if (specialty.toLowerCase().includes("emergency")) {
        return /emergency|trauma|medical center|hospital/.test(text);
    }

    return true;
}

function createBoundingBox(latitude, longitude, radiusKm) {
    const latDelta = radiusKm / 111;
    const lonDelta =
        radiusKm / (111 * Math.cos(latitude * Math.PI / 180));

    return {
        left: longitude - lonDelta,
        right: longitude + lonDelta,
        top: latitude + latDelta,
        bottom: latitude - latDelta
    };
}

function httpsGet(url, headers = {}) {
    return new Promise((resolve, reject) => {
        const request = https.get(
            url,
            {
                headers,
                timeout: 20000
            },
            response => {
                let data = "";

                response.on("data", chunk => {
                    data += chunk;
                });

                response.on("end", () => {
                    if (response.statusCode >= 200 && response.statusCode < 300) {
                        resolve(data);
                    } else {
                        reject(
                            new Error(
                                `HTTP ${response.statusCode}: ${data.slice(0, 300)}`
                            )
                        );
                    }
                });
            }
        );

        request.on("timeout", () => {
            request.destroy(new Error("Request timed out"));
        });

        request.on("error", reject);
    });
}

async function searchHospitals(latitude, longitude) {
    const box = createBoundingBox(
        latitude,
        longitude,
        SEARCH_RADIUS_KM
    );

    const params = new URLSearchParams({
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

    const raw = await httpsGet(url, {
        "User-Agent": "RapidRoute Emergency Coordination Demo/1.0"
    });

    return JSON.parse(raw);
}

async function fetchRealHospitals({
    latitude,
    longitude,
    specialty,
    emergency
}) {
    const results = await searchHospitals(latitude, longitude);

    const hospitals = [];

    for (const item of results) {
        const lat = Number(item.lat);
        const lon = Number(item.lon);

        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
            continue;
        }

        const distance = distanceKm(
            latitude,
            longitude,
            lat,
            lon
        );

        if (distance > SEARCH_RADIUS_KM) {
            continue;
        }

        const name =
            item.name ||
            item.display_name?.split(",")[0] ||
            "Hospital";

        const address =
            item.display_name || "Address unavailable";

        const specialtyMatch =
            specialtyMatches(name, address, specialty);

        const estimatedMinutes =
            Math.max(3, Math.round(distance * 3));

        let matchScore = 70;

        if (specialty && specialtyMatch) {
            matchScore += 20;
        }

        if (distance < 10) {
            matchScore += 10;
        } else if (distance < 25) {
            matchScore += 5;
        }

        matchScore = Math.min(99, matchScore);

        hospitals.push({
            name,
            address,
            latitude: lat,
            longitude: lon,
            distance: Number(distance.toFixed(1)),
            eta: estimatedMinutes,
            estimatedMinutes,
            matchScore,
            specialty: specialtyMatch && specialty
                ? [specialty]
                : ["Hospital"],
            source: "OpenStreetMap"
        });
    }

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

        if (aSpecialty !== bSpecialty) {
            return bSpecialty - aSpecialty;
        }

        return a.distance - b.distance;
    });

    return unique;
}

async function reverseGeocode(latitude, longitude) {
    const params = new URLSearchParams({
        lat: latitude,
        lon: longitude,
        format: "json",
        zoom: "18",
        addressdetails: "1"
    });

    const url =
        `https://nominatim.openstreetmap.org/reverse?${params.toString()}`;

    const raw = await httpsGet(url, {
        "User-Agent": "RapidRoute Emergency Coordination Demo/1.0"
    });

    return JSON.parse(raw);
}

function sendJson(response, statusCode, data) {
    const body = JSON.stringify(data);

    response.writeHead(statusCode, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
    });

    response.end(body);
}

function serveStatic(response, pathname) {
    let filePath;

    if (pathname === "/" || pathname === "") {
        filePath = path.join(
            __dirname,
            "public",
            "index.html"
        );
    } else {
        const cleanPath = pathname.replace(/^\/+/, "");

        filePath = path.join(
            __dirname,
            "public",
            cleanPath
        );
    }

    const publicFolder = path.join(
        __dirname,
        "public"
    );

    const normalizedPath = path.normalize(filePath);

    if (!normalizedPath.startsWith(publicFolder)) {
        response.writeHead(403);
        response.end("Forbidden");
        return;
    }

    fs.readFile(normalizedPath, (error, data) => {
        if (error) {
            response.writeHead(404);
            response.end("Not found");
            return;
        }

        const ext = path.extname(normalizedPath);

        const types = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".png": "image/png",
            ".webp": "image/webp",
            ".svg": "image/svg+xml"
        };

        response.writeHead(200, {
            "Content-Type":
                types[ext] || "application/octet-stream"
        });

        response.end(data);
    });
}

const server = http.createServer(async (request, response) => {
    if (request.method === "OPTIONS") {
        response.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type"
        });

        response.end();
        return;
    }

    try {
        const parsedUrl = new URL(
            request.url,
            `http://${request.headers.host}`
        );

        const pathname = parsedUrl.pathname;

        if (request.method === "GET" && pathname === "/api/health") {
            sendJson(response, 200, {
                status: "ok",
                service: "RapidRoute",
                hospitalData: "OpenStreetMap / Nominatim",
                searchRadiusKm: SEARCH_RADIUS_KM
            });
            return;
        }

        if (
            request.method === "GET" &&
            pathname === "/reverse-geocode"
        ) {
            const latitude =
                Number(parsedUrl.searchParams.get("lat"));

            const longitude =
                Number(parsedUrl.searchParams.get("lon"));

            if (
                !Number.isFinite(latitude) ||
                !Number.isFinite(longitude)
            ) {
                sendJson(response, 400, {
                    error: "Invalid coordinates"
                });
                return;
            }

            const result =
                await reverseGeocode(latitude, longitude);

            sendJson(response, 200, {
                display_name:
                    result.display_name ||
                    "Current location"
            });

            return;
        }

        if (
            request.method === "POST" &&
            pathname === "/find-hospital"
        ) {
            let body = "";

            request.on("data", chunk => {
                body += chunk;
            });

            request.on("end", async () => {
                try {
                    const input =
                        JSON.parse(body || "{}");

                    const latitude =
                        Number(input.latitude);

                    const longitude =
                        Number(input.longitude);

                    const specialty =
                        String(input.specialty || "");

                    const emergency =
                        String(input.emergency || "");

                    if (
                        !Number.isFinite(latitude) ||
                        !Number.isFinite(longitude)
                    ) {
                        sendJson(response, 400, {
                            error: "Valid latitude and longitude are required"
                        });
                        return;
                    }

                    const hospitals =
                        await fetchRealHospitals({
                            latitude,
                            longitude,
                            specialty,
                            emergency
                        });

                    sendJson(response, 200, {
                        ambulanceLocation: {
                            latitude,
                            longitude
                        },
                        emergencyType: emergency,
                        specialty,
                        totalFound: hospitals.length,
                        hospitals
                    });

                } catch (error) {
                    console.error(
                        "Hospital search error:",
                        error
                    );

                    sendJson(response, 500, {
                        error:
                            "Hospital search failed",
                        details:
                            error.message
                    });
                }
            });

            return;
        }

        serveStatic(response, pathname);

    } catch (error) {
        console.error(error);

        sendJson(response, 500, {
            error: "Server error"
        });
    }
});

server.listen(PORT, () => {
    console.log(
        `RapidRoute server running on port ${PORT}`
    );
});
