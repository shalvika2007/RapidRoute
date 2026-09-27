const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = 5000;
const PUBLIC = path.join(__dirname, "public");
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

function distance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const rad = d => d * Math.PI / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function normaliseSpecialties(tags = {}) {
  const raw = [
    tags["healthcare:speciality"],
    tags["healthcare:specialty"],
    tags["medical_specialty"],
    tags["speciality"],
    tags["specialty"]
  ].filter(Boolean).join(", ");

  if (!raw) return ["Hospital / healthcare facility"];

  return raw
    .split(/[;,|]/)
    .map(s => s.trim())
    .filter(Boolean)
    .slice(0, 5);
}

function specialtyMatches(hospital, requested) {
  if (!requested) return false;
  const wanted = requested.toLowerCase();
  const text = [hospital.name, ...(hospital.specialty || [])].join(" ").toLowerCase();

  const aliases = {
    "Cardiology": ["cardio", "heart"],
    "Trauma care": ["trauma", "accident"],
    "Neurology": ["neuro", "brain"],
    "Emergency medicine": ["emergency", "accident", "trauma", "casualty"]
  };

  if (text.includes(wanted.toLowerCase())) return true;
  return (aliases[requested] || []).some(alias => text.includes(alias));
}

async function fetchRealHospitals(latitude, longitude, requestedSpecialty) {
  const lat = Number(latitude);
  const lon = Number(longitude);

  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    throw new Error("Invalid location");
  }

  // OpenStreetMap's Overpass API returns mapped hospitals around the ambulance location.
  // 10 km keeps the result useful and the request reasonably small.
  const query = `[out:json][timeout:25];(nwr["amenity"="hospital"](around:10000,${lat},${lon});nwr["healthcare"="hospital"](around:10000,${lat},${lon}););out center;`;

  const response = await fetch(OVERPASS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "User-Agent": "RapidRoute student demo"
    },
    body: new URLSearchParams({ data: query })
  });

  if (!response.ok) {
    throw new Error(`OpenStreetMap service returned ${response.status}`);
  }

  const data = await response.json();

  const hospitals = (data.elements || [])
    .map(element => {
      const tags = element.tags || {};
      const hLat = element.lat ?? element.center?.lat;
      const hLon = element.lon ?? element.center?.lon;
      const name = tags.name || tags["name:en"];

      if (!name || !Number.isFinite(hLat) || !Number.isFinite(hLon)) return null;

      const km = distance(lat, lon, hLat, hLon);
      const eta = Math.max(3, Math.round(km * 3));
      const specialties = normaliseSpecialties(tags);
      const specialtyMatch = specialtyMatches({ name, specialty: specialties }, requestedSpecialty);

      let matchScore = 55;
      if (specialtyMatch) matchScore += 30;
      matchScore += Math.max(0, 15 - km);

      return {
        id: `${element.type}-${element.id}`,
        name,
        specialty: specialties,
        latitude: Number(hLat),
        longitude: Number(hLon),
        distance: Number(km.toFixed(1)),
        eta,
        matchScore: Math.min(99, Math.round(matchScore)),
        specialtyMatch,
        source: "OpenStreetMap"
      };
    })
    .filter(Boolean);

  // OSM can represent one hospital more than once (for example as a node
  // and a building area). Keep only the closest entry for each hospital name
  // so the displayed count represents unique hospitals, not raw map objects.
  const uniqueByName = new Map();
  for (const hospital of hospitals) {
    const key = hospital.name.trim().toLowerCase().replace(/\s+/g, " ");
    const existing = uniqueByName.get(key);
    if (!existing || hospital.distance < existing.distance) {
      uniqueByName.set(key, hospital);
    }
  }

  return [...uniqueByName.values()]
    .sort((a, b) => b.matchScore - a.matchScore || a.distance - b.distance);
}

async function reverseGeocode(latitude, longitude) {
  const lat = Number(latitude);
  const lon = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error("Invalid coordinates");

  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&zoom=18&addressdetails=1`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": "RapidRoute student demo/1.0 (local development)"
    }
  });
  if (!response.ok) throw new Error(`Geocoding service returned ${response.status}`);
  const data = await response.json();
  return {
    display_name: data.display_name || "Current location detected",
    latitude: lat,
    longitude: lon
  };
}

function json(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
  });
  res.end(JSON.stringify(data));
}

function staticFile(res, pathname) {
  let file = pathname === "/" ? path.join(PUBLIC, "index.html") : path.join(PUBLIC, pathname);
  file = path.normalize(file);
  if (!file.startsWith(PUBLIC)) return json(res, 403, { error: "Forbidden" });

  fs.readFile(file, (err, data) => {
    if (err) return json(res, 404, { error: "File not found" });
    const types = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8"
    };
    res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") return json(res, 204, {});

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/api/health") {
    return json(res, 200, {
      status: "online",
      system: "RapidRoute",
      hospitalData: "OpenStreetMap / Overpass"
    });
  }

  if (req.method === "GET" && url.pathname === "/reverse-geocode") {
    reverseGeocode(url.searchParams.get("lat"), url.searchParams.get("lon"))
      .then(data => json(res, 200, data))
      .catch(error => json(res, 502, { error: "Could not determine the readable location.", details: error.message }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/find-hospital") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const data = body ? JSON.parse(body) : {};
        const hospitals = await fetchRealHospitals(data.latitude, data.longitude, data.specialty);
        json(res, 200, {
          success: true,
          source: "OpenStreetMap",
          hospitals,
          totalFound: hospitals.length
        });
      } catch (error) {
        console.error("Hospital lookup failed:", error.message);
        json(res, 502, {
          success: false,
          error: "Could not load nearby real hospital data right now.",
          details: error.message
        });
      }
    });
    return;
  }

  if (req.method === "GET") return staticFile(res, url.pathname);
  json(res, 405, { error: "Method not allowed" });
});

server.listen(PORT, () => {
  console.log(`RapidRoute running at http://localhost:${PORT}`);
  console.log("Hospital source: OpenStreetMap / Overpass API");
});
