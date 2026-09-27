# RapidRoute — Real Hospital Data Version

This version keeps the RapidRoute frontend design and replaces the four demo hospitals with nearby mapped hospitals loaded from OpenStreetMap through the Overpass API.

## What is now real

- Browser location can be used as the ambulance location after permission is granted.
- Nearby hospital names and coordinates are fetched from OpenStreetMap when you click **Find Suitable Hospitals**.
- The results are sorted using distance and any specialty information mapped in OpenStreetMap.
- The tracking page uses the selected real hospital's coordinates.
- The tracking route attempts to use the OpenStreetMap-based OSRM routing service and falls back to a straight line if routing is unavailable.

## Important

This does **not** mean live bed/ICU/emergency capacity is available. OpenStreetMap is map/place data, not a hospital operations system. The UI therefore does not claim that beds are currently available.

## Run

1. Make sure Node.js is installed.
2. Open PowerShell in this folder.
3. Because PowerShell on some Windows systems blocks `npm.ps1`, use:

```powershell
npm.cmd start
```

4. Open:

http://localhost:5000

5. Click **Start Emergency** and allow location permission when Chrome asks.
6. Choose the emergency/specialty and click **Find Suitable Hospitals**.

## Data sources

Hospital/place data: OpenStreetMap via Overpass API.
Map tiles: OpenStreetMap.
Road routing: OSRM public routing service.

For a production medical system, hospital availability should come from verified hospital/government systems rather than being inferred from map data.
