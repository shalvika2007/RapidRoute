const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = 5000;
const PUBLIC = path.join(__dirname, "public");


/* =========================================================
   DISTANCE
   ========================================================= */

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

  return (
    R *
    2 *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(1 - a)
    )
  );
}


/* =========================================================
   SPECIALTIES
   ========================================================= */

function specialtyMatches(hospital, requested) {

  if (!requested) {
    return false;
  }

  const wanted = requested.toLowerCase();

  const text = [
    hospital.name,
    hospital.type || "",
    ...(hospital.specialty || [])
  ]
    .join(" ")
    .toLowerCase();

  const aliases = {

    "Cardiology": [
      "cardio",
      "heart"
    ],

    "Trauma care": [
      "trauma",
      "accident"
    ],

    "Neurology": [
      "neuro",
      "brain"
    ],

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

  return (
    aliases[requested] || []
  ).some(
    alias => text.includes(alias)
  );
}


/* =========================================================
   NOMINATIM HOSPITAL SEARCH
   ========================================================= */

async function searchHospitals(
  latitude,
  longitude
) {

  const url =
    "https://nominatim.openstreetmap.org/search" +
    "?format=jsonv2" +
    "&q=hospital" +
    `&lat=${encodeURIComponent(latitude)}` +
    `&lon=${encodeURIComponent(longitude)}` +
    "&limit=15" +
    "&addressdetails=1";

  console.log(
    "Searching OpenStreetMap for nearby hospitals..."
  );

  const response =
    await fetch(
      url,
      {
        method: "GET",

        headers: {
          "User-Agent":
            "RapidRoute/1.0 student emergency coordination project"
        },

        signal:
          AbortSignal.timeout(15000)
      }
    );

  if (!response.ok) {

    throw new Error(
      `OpenStreetMap search returned ${response.status}`
    );
  }

  return await response.json();
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

    throw new Error(
      "Invalid location"
    );
  }


  const places =
  await searchHospitals(
    lat,
    lon
  );

const nearbyPlaces =
  places.filter(place => {

    const hospitalLat =
      Number(place.lat);

    const hospitalLon =
      Number(place.lon);

    if (
      !Number.isFinite(hospitalLat) ||
      !Number.isFinite(hospitalLon)
    ) {
      return false;
    }

    const km =
      distance(
        lat,
        lon,
        hospitalLat,
        hospitalLon
      );

    return km <= 100;
  });

  const hospitals =
    nearbyPlaces
      .map(place => {

        const hLat =
          Number(place.lat);

        const hLon =
          Number(place.lon);

        const name =
          place.display_name
            ? place.display_name
                .split(",")[0]
                .trim()
            : null;


        if (
          !name ||
          !Number.isFinite(hLat) ||
          !Number.isFinite(hLon)
        ) {

          return null;
        }


        const km =
          distance(
            lat,
            lon,
            hLat,
            hLon
          );


        /*
          Simple distance-based ETA.

          This is NOT live traffic.
        */

        const eta =
          Math.max(
            3,
            Math.round(km * 3)
          );


        const specialty =
          [
            place.type,
            place.category
          ]
            .filter(Boolean);


        const specialtyMatch =
          specialtyMatches(
            {
              name,
              type:
                place.type,
              specialty
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
            place.place_id
              ? String(place.place_id)
              : `${hLat}-${hLon}`,

          name,

          specialty:
            specialty.length
              ? specialty
              : [
                  "Hospital / healthcare facility"
                ],

          latitude:
            hLat,

          longitude:
            hLon,

          distance:
            Number(
              km.toFixed(1)
            ),

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

  const unique =
    new Map();


  for (
    const hospital
    of hospitals
  ) {

    const key =
      hospital.name
        .trim()
        .toLowerCase()
        .replace(
          /\s+/g,
          " "
        );


    const existing =
      unique.get(key);


    if (
      !existing ||
      hospital.distance <
      existing.distance
    ) {

      unique.set(
        key,
        hospital
      );
    }
  }


  /*
    Sort by:
    1. Specialty match
    2. Match score
    3. Distance
  */

  const result =
    [...unique.values()]
      .sort(
        (a, b) => {

          if (
            b.specialtyMatch !==
            a.specialtyMatch
          ) {

            return (
              Number(b.specialtyMatch) -
              Number(a.specialtyMatch)
            );
          }

          if (
            b.matchScore !==
            a.matchScore
          ) {

            return (
              b.matchScore -
              a.matchScore
            );
          }

          return (
            a.distance -
            b.distance
          );
        }
      );


  console.log(
    `Hospital search successful: ${result.length} hospitals found`
  );


  return result;
}


/* =========================================================
   REVERSE GEOCODING
   ========================================================= */

async function reverseGeocode(
  latitude,
  longitude
) {

  const lat =
    Number(latitude);

  const lon =
    Number(longitude);


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
            "RapidRoute/1.0 student emergency coordination project"
        },

        signal:
          AbortSignal.timeout(10000)
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

    latitude:
      lat,

    longitude:
      lon

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
   STATIC FILES
   ========================================================= */

function staticFile(
  res,
  pathname
) {

  let file;


  if (pathname === "/") {

    file =
      path.join(
        PUBLIC,
        "index.html"
      );

  } else {

    file =
      path.join(
        PUBLIC,
        pathname
      );
  }


  file =
    path.normalize(file);


  if (
    !file.startsWith(
      PUBLIC
    )
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
          "application/json; charset=utf-8",

        ".jpg":
          "image/jpeg",

        ".jpeg":
          "image/jpeg",

        ".png":
          "image/png",

        ".webp":
          "image/webp"

      };


      res.writeHead(
        200,
        {

          "Content-Type":
            types[
              path.extname(
                file
              ).toLowerCase()
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


      /* OPTIONS */

      if (
        req.method ===
        "OPTIONS"
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


      /* HEALTH */

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
              "OpenStreetMap / Nominatim"

          }
        );
      }


      /* REVERSE GEOCODE */

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

                  hospitals:

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


      /* FRONTEND */

      if (
        req.method === "GET"
      ) {

        return staticFile(
          res,
          url.pathname
        );
      }


      /* OTHER METHODS */

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
   START
   ========================================================= */

server.listen(
  PORT,
  () => {

    console.log(
      `RapidRoute running at http://localhost:${PORT}`
    );

    console.log(
      "Hospital source: OpenStreetMap / Nominatim"
    );

  }
);
