// Import Mapbox and D3 as ES modules
import mapboxgl from 'https://cdn.jsdelivr.net/npm/mapbox-gl@2.15.0/+esm';
import * as d3 from 'https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm';

// Quick check that Mapbox GL JS loaded (look for this in the browser console)
console.log('Mapbox GL JS Loaded:', mapboxgl);

// ============================================================
// TODO: PASTE YOUR MAPBOX ACCESS TOKEN BELOW.
// 1. Go to https://account.mapbox.com/
// 2. Copy your "Default public token" (it starts with "pk.")
// 3. Replace the text inside the quotes below with that token.
// ============================================================
mapboxgl.accessToken = 'YOUR_ACCESS_TOKEN_HERE';

// Create the map, centered on the Boston / Cambridge area
const map = new mapboxgl.Map({
  container: 'map', // id of the <div> that holds the map
  style: 'mapbox://styles/mapbox/streets-v12', // basemap style
  center: [-71.09415, 42.36027], // [longitude, latitude]
  zoom: 12, // initial zoom level
  minZoom: 5, // most zoomed out allowed
  maxZoom: 18, // most zoomed in allowed
});

// Shared styling for both bike-lane layers (so we only write it once)
const bikeLaneStyle = {
  'line-color': '#32D400',
  'line-width': 5,
  'line-opacity': 0.6,
};

// ----- Helper functions (global so they can be used anywhere) -----

// Convert a station's longitude/latitude into pixel coordinates on the map.
// map.project() handles panning, zooming and rotation for us.
function getCoords(station) {
  const point = new mapboxgl.LngLat(+station.lon, +station.lat);
  const { x, y } = map.project(point);
  return { cx: x, cy: y };
}

// Format a number of minutes since midnight as e.g. "6:32 PM"
function formatTime(minutes) {
  const date = new Date(0, 0, 0, 0, minutes);
  return date.toLocaleString('en-US', { timeStyle: 'short' });
}

// Return how many minutes have passed since midnight for a given Date
function minutesSinceMidnight(date) {
  return date.getHours() * 60 + date.getMinutes();
}

// Buckets of trips, one array per minute of the day (1440 minutes = 24 * 60).
// These let us look up trips by time without scanning all 260,000+ trips.
let departuresByMinute = Array.from({ length: 1440 }, () => []);
let arrivalsByMinute = Array.from({ length: 1440 }, () => []);

// Efficiently return all trips within 60 minutes of `minute`.
// If minute is -1, no filtering is applied and every trip is returned.
function filterByMinute(tripsByMinute, minute) {
  if (minute === -1) {
    return tripsByMinute.flat(); // no filtering: return all trips
  }

  // Normalize the 60-minute window into the valid range [0, 1439]
  let minMinute = (minute - 60 + 1440) % 1440;
  let maxMinute = (minute + 60) % 1440;

  if (minMinute > maxMinute) {
    // The window wraps across midnight, so grab two slices
    let beforeMidnight = tripsByMinute.slice(minMinute);
    let afterMidnight = tripsByMinute.slice(0, maxMinute);
    return beforeMidnight.concat(afterMidnight).flat();
  } else {
    return tripsByMinute.slice(minMinute, maxMinute).flat();
  }
}

// Add arrivals / departures / totalTraffic properties to every station.
// timeFilter of -1 means "use all trips".
function computeStationTraffic(stations, timeFilter = -1) {
  // Count departures per station id
  const departures = d3.rollup(
    filterByMinute(departuresByMinute, timeFilter),
    (v) => v.length,
    (d) => d.start_station_id,
  );

  // Count arrivals per station id
  const arrivals = d3.rollup(
    filterByMinute(arrivalsByMinute, timeFilter),
    (v) => v.length,
    (d) => d.end_station_id,
  );

  return stations.map((station) => {
    let id = station.short_name;
    station.departures = departures.get(id) ?? 0;
    station.arrivals = arrivals.get(id) ?? 0;
    station.totalTraffic = station.departures + station.arrivals;
    return station;
  });
}

// Wait for the map to fully load before adding data and overlays
map.on('load', async () => {
  // ----- Step 2: Bike lanes -----

  // Boston bike network
  map.addSource('boston_route', {
    type: 'geojson',
    data: 'https://bostonopendata-boston.opendata.arcgis.com/datasets/boston::existing-bike-network-2022.geojson',
  });
  map.addLayer({
    id: 'bike-lanes-boston',
    type: 'line',
    source: 'boston_route',
    paint: bikeLaneStyle,
  });

  // Cambridge bike network
  map.addSource('cambridge_route', {
    type: 'geojson',
    data: 'https://raw.githubusercontent.com/cambridgegis/cambridgegis_data/main/Recreation/Bike_Facilities/RECREATION_BikeFacilities.geojson',
  });
  map.addLayer({
    id: 'bike-lanes-cambridge',
    type: 'line',
    source: 'cambridge_route',
    paint: bikeLaneStyle,
  });

  // ----- Step 3 & 4: Load station and traffic data -----

  let jsonData;
  try {
    const jsonurl = 'https://dsc106.com/labs/lab07/data/bluebikes-stations.json';
    jsonData = await d3.json(jsonurl);
    console.log('Loaded JSON Data:', jsonData);
  } catch (error) {
    console.error('Error loading JSON:', error);
  }

  // Load the trips CSV. The third argument runs once per row, letting us
  // convert the date strings to Date objects and fill the minute buckets.
  await d3.csv(
    'https://dsc106.com/labs/lab07/data/bluebikes-traffic-2024-03.csv',
    (trip) => {
      trip.started_at = new Date(trip.started_at);
      trip.ended_at = new Date(trip.ended_at);

      // Drop this trip into the right departure/arrival minute buckets
      let startedMinutes = minutesSinceMidnight(trip.started_at);
      departuresByMinute[startedMinutes].push(trip);

      let endedMinutes = minutesSinceMidnight(trip.ended_at);
      arrivalsByMinute[endedMinutes].push(trip);

      return trip;
    },
  );

  // Compute traffic for every station (defaults to all trips)
  const stations = computeStationTraffic(jsonData.data.stations);
  console.log('Stations with traffic:', stations);

  // ----- Step 3.2 & 3.3: Draw station circles on the SVG overlay -----

  const svg = d3.select('#map').select('svg');

  // Square-root scale: a circle's AREA (not radius) is proportional to
  // traffic, so a station with double the traffic looks twice as big.
  const radiusScale = d3
    .scaleSqrt()
    .domain([0, d3.max(stations, (d) => d.totalTraffic)])
    .range([0, 25]);

  // Quantize scale: turns the departure ratio (0..1) into one of three
  // discrete values so the colors read as three clear categories.
  const stationFlow = d3.scaleQuantize().domain([0, 1]).range([0, 0.5, 1]);

  // Append one <circle> per station
  const circles = svg
    .selectAll('circle')
    .data(stations, (d) => d.short_name) // key: keep circles tied to stations
    .enter()
    .append('circle')
    .attr('r', (d) => radiusScale(d.totalTraffic))
    .style('--departure-ratio', (d) =>
      stationFlow(d.departures / d.totalTraffic),
    )
    .each(function (d) {
      // Browser tooltip showing exact numbers when you hover a circle
      d3.select(this)
        .append('title')
        .text(
          `${d.totalTraffic} trips (${d.departures} departures, ${d.arrivals} arrivals)`,
        );
    });

  // Keep the circles lined up with the map as it pans / zooms / resizes
  function updatePositions() {
    circles
      .attr('cx', (d) => getCoords(d).cx)
      .attr('cy', (d) => getCoords(d).cy);
  }
  updatePositions();

  map.on('move', updatePositions);
  map.on('zoom', updatePositions);
  map.on('resize', updatePositions);
  map.on('moveend', updatePositions);

  // ----- Step 5: Interactive time filtering -----

  const timeSlider = document.getElementById('time-slider');
  const selectedTime = document.getElementById('selected-time');
  const anyTimeLabel = document.getElementById('any-time');

  // Recompute traffic for the selected time and update the circles
  function updateScatterPlot(timeFilter) {
    const filteredStations = computeStationTraffic(stations, timeFilter);

    // When filtering, fewer trips are shown, so make the circles bigger
    timeFilter === -1
      ? radiusScale.range([0, 25])
      : radiusScale.range([3, 50]);

    circles
      .data(filteredStations, (d) => d.short_name)
      .join('circle')
      .attr('r', (d) => radiusScale(d.totalTraffic))
      .style('--departure-ratio', (d) =>
        stationFlow(d.departures / d.totalTraffic),
      );
  }

  // Update the time text next to the slider, then refresh the map
  function updateTimeDisplay() {
    let timeFilter = Number(timeSlider.value);

    if (timeFilter === -1) {
      selectedTime.textContent = ''; // clear the time
      anyTimeLabel.style.display = 'block'; // show "(any time)"
    } else {
      selectedTime.textContent = formatTime(timeFilter); // show the time
      anyTimeLabel.style.display = 'none'; // hide "(any time)"
    }

    updateScatterPlot(timeFilter);
  }

  timeSlider.addEventListener('input', updateTimeDisplay);
  updateTimeDisplay(); // run once so the map starts in the right state
});
