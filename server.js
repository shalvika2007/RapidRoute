const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = 5000;
const PUBLIC = path.join(__dirname, "public");

const OVERPASS_URLS = [
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter"
];

function distance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const rad = d => d * Math.PI / 180;

  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) *
      Math.cos(rad(lat2)) *
      Math.sin(dLon / 2) ** 2;

  return R * 2 * Math.atan2(
    Math.sqrt(a),
    Math.sqrt(1 - a)
  );
}

function normaliseSpecialties(tags = {}) {
  const raw = [
    tags["healthcare:speciality"],
    tags["healthcare:specialty"],
    tags["medical_specialty"],
    tags["speciality"],
    tags["specialty"]
  ]
    .filter(Boolean)
    .join(", ");

  if (!raw) {
    return ["Hospital / healthcare facility"];
  }

  return raw
    .split(/[;,|]/)
    .map(s => s.trim())
    .filter(Boolean)
    .slice(0, 5);
}

function specialtyMatches(hospital, requested) {
  if (!requested) return false;

  const wanted = requested.toLowerCase();

  const text = [
    hospital.name,
    ...(hospital.specialty || [])
  ]
    .join(" ")
    .toLowerCase();

  const aliases = {
    "Cardiology": ["cardio", "heart"],
    "Trauma care": ["trauma", "accident"],
    "Neurology": ["neuro", "brain"],
    "Emergency medicine": [
      "emergency",
      "accident",
      "trauma",
      "casualty"
    ]
  };

  if (text.includes(wanted)) {
    return true;
  }

  return (aliases[requested] || []).some(
    alias => text.includes(alias)
  );
}


/* =========================================================
   FIND REAL HOSPITALS
   ========================================================= */

async function fetchRealHospitals(
  latitude,
  longitude,
  requestedSpecialty
) {
  const lat = Number(latitude);
  const lon = Number(longitude);

  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    lat < -90 ||
    lat > 90 ||
    lon < -180 ||
    lon > 180
  ) {
    throw new Error("Invalid location");
  }

  /*
    We search within 5 km instead of 10 km.
    This makes the Overpass request much smaller
    and reduces timeout problems.
  */

  const query = `
    [out:json][timeout:15];
    nwr["amenity"="hospital"](around:5000,${lat},${lon});
    out center;
  `;

  let lastError = null;

  /*
    Try several Overpass servers.
    If one is unavailable, RapidRoute automatically
    tries the next one.
  */

  for (const overpassURL of OVERPASS_URLS) {

    try {

      console.log(
        "Trying hospital server:",
        overpassURL
      );

      const response = await fetch(
        overpassURL,
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/x-www-form-urlencoded",
            "User-Agent":
              "RapidRoute student demo"
          },

          body: new URLSearchParams({
            data: query
          }),

          signal: AbortSignal.timeout(20000)
        }
      );

      if (!response.ok) {
        throw new Error(
          `OpenStreetMap service returned ${response.status}`
        );
      }

      const data = await response.json();

      const hospitals = (data.elements || [])
        .map(element => {

          const tags = element.tags || {};

          const hLat =
            element.lat ??
            element.center?.lat;

          const hLon =
            element.lon ??
            element.center?.lon;

          const name =
            tags.name ||
            tags["name:en"];

          if (
            !name ||
            !Number.isFinite(hLat) ||
            !Number.isFinite(hLon)
          ) {
            return null;
          }

          const km = distance(
            lat,
            lon,
            hLat,
            hLon
          );

          /*
            Simple estimated travel time.
            This is NOT live traffic ETA.
          */

          const eta = Math.max(
            3,
            Math.round(km * 3)
          );

          const specialties =
            normaliseSpecialties(tags);

          const specialtyMatch =
            specialtyMatches(
              {
                name,
                specialty: specialties
              },
              requestedSpecialty
            );

          let matchScore = 55;

          if (specialtyMatch) {
            matchScore += 30;
          }

          matchScore += Math.max(
            0,
            15 - km
          );

          return {
            id:
              `${element.type}-${element.id}`,

            name,

            specialty:
              specialties,

            latitude:
              Number(hLat),

            longitude:
              Number(hLon),

            distance:
              Number(km.toFixed(1)),

            eta,

            matchScore:
              Math.min(
                99,
                Math.round(matchScore)
              ),

            specialtyMatch,

            source:
              "OpenStreetMap"
          };
        })
        .filter(Boolean);


      /*
        Remove duplicate hospitals.
      */

      const uniqueByName =
        new Map();

      for (const hospital of hospitals) {

        const key =
          hospital.name
            .trim()
            .toLowerCase()
            .replace(/\s+/g, " ");

        const existing =
          uniqueByName.get(key);

        if (
          !existing ||
          hospital.distance <
            existing.distance
        ) {
          uniqueByName.set(
            key,
            hospital
          );
        }
      }


      const result =
        [...uniqueByName.values()]
          .sort(
            (a, b) =>
              b.matchScore -
                a.matchScore ||
              a.distance -
                b.distance
          );


      console.log(
        `Hospital search successful: ${result.length} hospitals found`
      );

      return result;

    } catch (error) {

      console.error(
        `Hospital server failed: ${overpassURL}`,
        error.message
      );

      lastError = error;
    }
  }

  throw (
    lastError ||
    new Error(
      "All hospital servers failed"
    )
  );
}


/* =========================================================
   REVERSE GEOCODING
   ========================================================= */

async function reverseGeocode(
  latitude,
  longitude
) {
  const lat = Number(latitude);
  const lon = Number(longitude);

  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon)
  ) {
    throw new Error(
      "Invalid coordinates"
    );
  }

  const url =
    `https://nominatim.openstreetmap.org/reverse` +
    `?format=jsonv2` +
    `&lat=${encodeURIComponent(lat)}` +
    `&lon=${encodeURIComponent(lon)}` +
    `&zoom=18` +
    `&addressdetails=1`;

  const response =
    await fetch(
      url,
      {
        headers: {
          "User-Agent":
            "RapidRoute student demo/1.0"
        }
      }
    );

  if (!response.ok) {
    throw new Error(
      `Geocoding service returned ${response.status}`
    );
  }

  const data =
    await response.json();

  return {
    display_name:
      data.display_name ||
      "Current location detected",

    latitude: lat,

    longitude: lon
  };
}


/* =========================================================
   JSON RESPONSE
   ========================================================= */

function json(
  res,
  status,
  data
) {
  res.writeHead(
    status,
    {
      "Content-Type":
        "application/json; charset=utf-8",

      "Access-Control-Allow-Origin":
        "*",

      "Access-Control-Allow-Headers":
        "Content-Type",

      "Access-Control-Allow-Methods":
        "GET,POST,OPTIONS"
    }
  );

  res.end(
    JSON.stringify(data)
  );
}


/* =========================================================
   STATIC FILE SERVER
   ========================================================= */

function staticFile(
  res,
  pathname
) {
  let file =
    pathname === "/"
      ? path.join(
          PUBLIC,
          "index.html"
        )
      : path.join(
          PUBLIC,
          pathname
        );

  file =
    path.normalize(file);

  if (
    !file.startsWith(PUBLIC)
  ) {
    return json(
      res,
      403,
      {
        error:
          "Forbidden"
      }
    );
  }

  fs.readFile(
    file,
    (err, data) => {

      if (err) {
        return json(
          res,
          404,
          {
            error:
              "File not found"
          }
        );
      }

      const types = {

        ".html":
          "text/html; charset=utf-8",

        ".css":
          "text/css; charset=utf-8",

        ".js":
          "application/javascript; charset=utf-8",

        ".json":
          "application/json; charset=utf-8"
      };

      res.writeHead(
        200,
        {
          "Content-Type":
            types[
              path.extname(file)
            ] ||
            "application/octet-stream"
        }
      );

      res.end(data);
    }
  );
}


/* =========================================================
   SERVER
   ========================================================= */

const server =
  http.createServer(
    (req, res) => {

      /* CORS preflight */

      if (
        req.method === "OPTIONS"
      ) {
        return json(
          res,
          204,
          {}
        );
      }


      const url =
        new URL(
          req.url,
          `http://${req.headers.host}`
        );


      /* HEALTH CHECK */

      if (
        req.method === "GET" &&
        url.pathname ===
          "/api/health"
      ) {

        return json(
          res,
          200,
          {
            status:
              "online",

            system:
              "RapidRoute",

            hospitalData:
              "OpenStreetMap / Overpass"
          }
        );
      }


      /* REVERSE GEOCODING */

      if (
        req.method === "GET" &&
        url.pathname ===
          "/reverse-geocode"
      ) {

        reverseGeocode(
          url.searchParams.get(
            "lat"
          ),

          url.searchParams.get(
            "lon"
          )
        )

          .then(
            data =>
              json(
                res,
                200,
                data
              )
          )

          .catch(
            error =>
              json(
                res,
                502,
                {
                  error:
                    "Could not determine the readable location.",

                  details:
                    error.message
                }
              )
          );

        return;
      }


      /* FIND HOSPITAL */

      if (
        req.method === "POST" &&
        url.pathname ===
          "/find-hospital"
      ) {

        let body = "";

        req.on(
          "data",
          chunk => {
            body += chunk;
          }
        );

        req.on(
          "end",
          async () => {

            try {

              const data =
                body
                  ? JSON.parse(body)
                  : {};

              const hospitals =
                await fetchRealHospitals(
                  data.latitude,
                  data.longitude,
                  data.specialty
                );


              json(
                res,
                200,
                {
                  success:
                    true,

                  source:
                    "OpenStreetMap",

                  hospitals,

                  totalFound:
                    hospitals.length
                }
              );

            } catch (error) {

              console.error(
                "Hospital lookup failed:",
                error.message
              );

              json(
                res,
                502,
                {
                  success:
                    false,

                  error:
                    "Could not load nearby real hospital data right now.",

                  details:
                    error.message
                }
              );
            }
          }
        );

        return;
      }


      /* STATIC FRONTEND */

      if (
        req.method === "GET"
      ) {
        return staticFile(
          res,
          url.pathname
        );
      }


      /* METHOD NOT ALLOWED */

      json(
        res,
        405,
        {
          error:
            "Method not allowed"
        }
      );
    }
  );


/* =========================================================
   START SERVER
   ========================================================= */

server.listen(
  PORT,
  () => {

    console.log(
      `RapidRoute running at http://localhost:${PORT}`
    );

    console.log(
      "Hospital source: OpenStreetMap / Overpass API"
    );
  }
);
