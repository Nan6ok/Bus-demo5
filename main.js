// Bus Demo 6 - KMB (real GPS every 5s) + CTB/NWFB (ETA + estimated markers)
// 注意：若 API 回應被瀏覽器拒絕（CORS），將會在 console 見到錯誤。
// update interval: 5s for KMB vehicles; ETA update for CTB/NWFB every 30s.

const map = L.map('map').setView([22.302711, 114.177216], 12);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19}).addTo(map);

const clockEl = document.getElementById('clock');
function updateClock(){ clockEl.textContent = new Date().toLocaleTimeString('zh-HK',{hour12:false}); }
setInterval(updateClock,1000); updateClock();

const companySelect = document.getElementById('companySelect');
const routeSelect = document.getElementById('routeSelect');
const dirBtn = document.getElementById('dirBtn');
const stopListEl = document.getElementById('stopList');

let operator = 'all';
let currentRoute = 'all';
let direction = 'inbound';
let stopCoords = [];
let stopIds = [];
let vehicleMarkers = {}; // key -> marker
let kmbTimer = null;
let etaupdateTimer = null;

// API bases
const KMB_BASE = 'https://data.etabus.gov.hk/v1/transport/kmb';
const CITYBUS_BASE = 'https://rt.data.gov.hk/v1/transport/citybus-nwfb';

// UI events
companySelect.addEventListener('change', ()=>{
  operator = companySelect.value;
  currentRoute = 'all';
  routeSelect.innerHTML = '<option value="all">所有路線</option>';
  clearMap();
  loadRoutes();
});

dirBtn.addEventListener('click', ()=>{
  direction = (direction === 'inbound') ? 'outbound' : 'inbound';
  if(currentRoute !== 'all') loadRouteStops(currentRoute);
});

// initial
loadRoutes();

// -------------------- functions --------------------

async function loadRoutes(){
  // populate routes for selected operator (KMB + Citybus)
  routeSelect.innerHTML = '<option>載入中...</option>';
  try{
    const routeSet = new Set();

    if(operator === 'all' || operator === 'kmb'){
      const r = await fetchJSON(`${KMB_BASE}/route`);
      (r.data||[]).forEach(item => routeSet.add(`KMB ${item.route}`));
    }

    if(operator === 'all' || operator === 'ctb' || operator === 'nwfb'){
      const r2 = await fetchJSON(`${CITYBUS_BASE}/route`);
      (r2.data||[]).forEach(item=>{
        // item might contain operator field; use .operator if exists
        const co = (item.operator || item.co || '').toUpperCase() || 'CTB';
        // filter if user selected a specific company
        if(operator==='all' || (operator==='ctb' && co.includes('CTB')) || (operator==='nwfb' && co.includes('NWFB'))){
          routeSet.add(`${co} ${item.route}`);
        }
      });
    }

    // populate select
    routeSelect.innerHTML = '';
    routeSelect.appendChild(new Option('所有路線','all'));
    Array.from(routeSet).sort().forEach(rt => {
      routeSelect.appendChild(new Option(rt, rt));
    });

    // on change
    routeSelect.onchange = () => {
      currentRoute = routeSelect.value;
      clearMap();
      if(currentRoute === 'all') {
        loadAllVehicles();
      } else {
        loadRouteStops(currentRoute);
      }
    };

    // default: show all vehicles
    loadAllVehicles();

  }catch(e){
    console.error('loadRoutes error', e);
    routeSelect.innerHTML = '<option>讀取路線失敗</option>';
  }
}

function clearMap(){
  map.eachLayer(layer=>{
    if(layer instanceof L.Marker || layer instanceof L.Polyline || layer instanceof L.CircleMarker){
      map.removeLayer(layer);
    }
  });
  vehicleMarkers = {};
  stopCoords = [];
  stopIds = [];
  stopListEl.innerHTML = '';
  if(kmbTimer){ clearInterval(kmbTimer); kmbTimer = null; }
  if(etaupdateTimer){ clearInterval(etaupdateTimer); etaupdateTimer = null; }
}

// load all vehicles (show all KMB vehicles by default; CTB/NWFB estimation optional)
async function loadAllVehicles(){
  clearMap();
  // show KMB vehicles
  await loadKMBVehicles(null);
  // schedule periodic KMB refresh
  if(kmbTimer) clearInterval(kmbTimer);
  kmbTimer = setInterval(()=> loadKMBVehicles(null), 5000);
}

// load route stops + ETA + start vehicle updates for that route
async function loadRouteStops(routeFull){
  // routeFull like "KMB 1A" or "CTB 107"
  const parts = routeFull.split(' ');
  const co = parts[0];
  const route = parts.slice(1).join(' ');
  stopListEl.innerHTML = '<li>載入站點...</li>';
  clearMap();

  if(co === 'KMB'){
    // KMB route stops
    try{
      const res = await fetchJSON(`${KMB_BASE}/route-stop/${route}/${direction}/1`);
      const stopsData = res.data || [];
      stopCoords = []; stopIds = [];
      for(const s of stopsData){
        // fetch stop info
        try{
          const info = await fetchJSON(`${KMB_BASE}/stop/${s.stop}`);
          const d = info.data;
          stopCoords.push([d.lat, d.long]);
          stopIds.push(s.stop);
          L.circleMarker([d.lat, d.long],{radius:5}).addTo(map).bindPopup(`${d.name_tc}<br>${d.name_en}`);
        }catch(e){ console.warn('stop info fail', e); }
      }
      if(stopCoords.length){
        const poly = L.polyline(stopCoords,{color:'blue',weight:4}).addTo(map);
        map.fitBounds(poly.getBounds());
      }
      // ETA list
      await updateETAsKMB(route);
      // start KMB vehicle polling (route filtered)
      if(kmbTimer) clearInterval(kmbTimer);
      await loadKMBVehicles(route);
      kmbTimer = setInterval(()=> loadKMBVehicles(route), 5000);

    }catch(e){
      console.error('loadRouteStops KMB error', e);
      stopListEl.innerHTML = '<li>載入站點失敗</li>';
    }
  } else if(co === 'CTB' || co === 'NWFB'){
    // citybus route-stop: endpoint shape may be /route/CTB/{route}/{dir}
    try{
      const res = await fetchJSON(`${CITYBUS_BASE}/route-stop/CTB/${route}/${direction}`);
      const stopsData = res.data || [];
      stopCoords = []; stopIds = [];
      stopsData.forEach(s=>{
        if(s.stop_lat && s.stop_lon){
          stopCoords.push([s.stop_lat, s.stop_lon]);
          stopIds.push(s.stop);
          L.circleMarker([s.stop_lat,s.stop_lon],{radius:5}).addTo(map).bindPopup(`${s.stop_tc || ''}<br>${s.stop_en || ''}`);
        }
      });
      if(stopCoords.length){
        L.polyline(stopCoords,{color:'#ff9800',weight:4}).addTo(map);
        map.fitBounds(L.polyline(stopCoords).getBounds());
      }
      // show ETA list
      await updateETAsCTB(route);
      // CTB/NWFB GPS not public — show estimated markers
      startEstimateCTB(route);
    }catch(e){
      console.error('loadRouteStops CTB error', e);
      stopListEl.innerHTML = '<li>載入站點失敗</li>';
    }
  } else {
    stopListEl.innerHTML = '<li>尚未支援此公司路線</li>';
  }
}

// ---------- KMB functions ----------
async function updateETAsKMB(route){
  try{
    const res = await fetchJSON(`${KMB_BASE}/eta/${route}/${direction}/1`);
    const data = res.data || [];
    const etaMap = {};
    data.forEach(e => { if(!etaMap[e.stop]) etaMap[e.stop]=[]; etaMap[e.stop].push(e.eta); });

    stopListEl.innerHTML = '';
    for(let i=0;i<stopIds.length;i++){
      const sid = stopIds[i];
      const li = document.createElement('li');
      const span = document.createElement('span'); span.className='eta';
      if(etaMap[sid] && etaMap[sid].length){
        const next = new Date(etaMap[sid][0]);
        const mins = Math.max(0, Math.floor((next - new Date())/60000));
        span.textContent = mins + ' 分鐘';
      } else { span.textContent = '暫無班次'; }
      li.innerHTML = `<span class="stop-name">${sid}</span>`;
      li.appendChild(span);
      stopListEl.appendChild(li);
    }
  }catch(e){ console.warn('updateETAsKMB err',e); }
}

async function loadKMBVehicles(routeFilter=null){
  try{
    const res = await fetchJSON(`${KMB_BASE}/vehicle`);
    const vehicles = res.data || [];
    let filtered = vehicles;
    if(routeFilter && routeFilter !== 'all'){
      filtered = vehicles.filter(v => v.route === routeFilter);
    }
    const newKeys = new Set();
    filtered.forEach(v=>{
      const key = v.plate || `${v.route}_${v.vehicle}` || JSON.stringify(v);
      newKeys.add(key);
      const lat = Number(v.lat), lng = Number(v.long);
      if(isNaN(lat) || isNaN(lng)) return;
      if(vehicleMarkers[key]){
        vehicleMarkers[key].setLatLng([lat,lng]);
      } else {
        const m = L.marker([lat,lng], { icon: L.divIcon({className:'bus-icon', html:'🚌'}) }).addTo(map);
        m.bindPopup(`公司: KMB<br>路線: ${v.route}<br>車牌: ${v.plate || v.vehicle}`);
        vehicleMarkers[key] = m;
      }
    });
    // remove old keys not present
    Object.keys(vehicleMarkers).forEach(k=>{
      if(!newKeys.has(k)){
        map.removeLayer(vehicleMarkers[k]);
        delete vehicleMarkers[k];
      }
    });
  }catch(e){
    console.warn('loadKMBVehicles err', e);
  }
}

// ---------- CTB / NWFB functions (ETA + simple estimation) ----------
async function updateETAsCTB(route){
  try{
    // Using Citybus NWFB ETA endpoint; path may vary by dataset version.
    const res = await fetchJSON(`${CITYBUS_BASE}/eta/CTB/${route}`);
    const data = res.data || [];
    const etaMap = {};
    data.forEach(e => { if(!etaMap[e.stop]) etaMap[e.stop]=[]; etaMap[e.stop].push(e.eta); });

    stopListEl.innerHTML = '';
    for(let i=0;i<stopCoords.length;i++){
      const sid = stopIds[i] || `s${i}`;
      const li = document.createElement('li');
      const span = document.createElement('span'); span.className='eta';
      if(etaMap[sid] && etaMap[sid].length){
        const next = new Date(etaMap[sid][0]);
        const mins = Math.max(0, Math.floor((next - new Date())/60000));
        span.textContent = mins + ' 分鐘';
      } else { span.textContent = '暫無班次'; }
      li.innerHTML = `<span class="stop-name">${sid}</span>`;
      li.appendChild(span);
      stopListEl.appendChild(li);
    }
  }catch(e){ console.warn('updateETAsCTB err', e); }
}

// very simple CTB vehicle estimation (visual only)
let ctbEstimateTimer = null;
function startEstimateCTB(route){
  if(ctbEstimateTimer) clearInterval(ctbEstimateTimer);
  estimateCTBVehicles(route);
  ctbEstimateTimer = setInterval(()=> estimateCTBVehicles(route), 5000);
}
function estimateCTBVehicles(route){
  if(stopCoords.length < 2) return;
  const count = Math.min(3, Math.max(1, Math.floor(stopCoords.length/10))); // small number
  const newKeys = new Set();
  for(let i=0;i<count;i++){
    const frac = (i+1)/(count+1);
    const idx = Math.floor(frac * (stopCoords.length-1));
    const pos = stopCoords[idx];
    const key = `CTB_${route}_est_${i}`;
    newKeys.add(key);
    if(vehicleMarkers[key]){
      vehicleMarkers[key].setLatLng(pos);
    } else {
      const m = L.marker(pos, { icon: L.divIcon({className:'bus-icon estimated', html:'🚌'}) }).addTo(map);
      m.bindPopup(`公司: CTB (估算位置)<br>路線: ${route}<br><small>由 ETA 推估，非 GPS</small>`);
      vehicleMarkers[key] = m;
    }
  }
  // cleanup old
  Object.keys(vehicleMarkers).forEach(k=>{
    if(k.startsWith('CTB_') && !newKeys.has(k)){
      map.removeLayer(vehicleMarkers[k]); delete vehicleMarkers[k];
    }
  });
}

// ---------- helper: fetch with JSON and error handling ----------
async function fetchJSON(url){
  const res = await fetch(url);
  if(!res.ok){
    throw new Error(`${res.status} ${res.statusText} ${url}`);
  }
  return res.json();
}
// 儲存 marker 狀態
let busMarkers = {}; // { plate: { marker, lat, lng } }

// 插值移動 function
function animateMarker(marker, fromLatLng, toLatLng, duration = 5000) {
  const start = performance.now();

  function step(now) {
    const progress = Math.min((now - start) / duration, 1);
    const lat = fromLatLng.lat + (toLatLng.lat - fromLatLng.lat) * progress;
    const lng = fromLatLng.lng + (toLatLng.lng - fromLatLng.lng) * progress;

    marker.setLatLng([lat, lng]);

    if (progress < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

// 更新巴士位置（每 5 秒）
async function loadBusPositions() {
  try {
    const res = await fetch("https://data.etabus.gov.hk/v1/transport/kmb/vehicle");
    const data = await res.json();
    const buses = data.data;

    buses.forEach(bus => {
      const plate = bus.plate;
      const newLatLng = { lat: parseFloat(bus.lat), lng: parseFloat(bus.long) };

      if (busMarkers[plate]) {
        // 已有 marker → 平滑郁去新位置
        animateMarker(busMarkers[plate].marker, busMarkers[plate], newLatLng, 5000);
        busMarkers[plate].lat = newLatLng.lat;
        busMarkers[plate].lng = newLatLng.lng;
      } else {
        // 未有 → 新增 marker
        const marker = L.marker([newLatLng.lat, newLatLng.lng], {
          icon: L.divIcon({
            className: "bus-icon",
            html: "🚌",
            iconSize: [30, 30]
          })
        }).addTo(map);

        marker.bindPopup(`路線 ${bus.route}<br>車牌: ${plate}`);
        busMarkers[plate] = { marker, ...newLatLng };
      }
    });
  } catch (err) {
    console.error("載入巴士位置失敗:", err);
  }
}

// 每 5 秒更新 API
setInterval(loadBusPositions, 5000);
loadBusPositions();
let busMarkers = {};

async function updateBuses() {
  try {
    let res = await fetch("https://data.etabus.gov.hk/v1/transport/kmb/vehicle-position");
    let data = await res.json();

    // 清除舊 marker
    Object.values(busMarkers).forEach(m => map.removeLayer(m));
    busMarkers = {};

    data.data.forEach(bus => {
      let lat = bus.lat;
      let long = bus.long;
      let plate = bus.plate;

      let marker = L.marker([lat, long]).addTo(map)
        .bindPopup(`車牌: ${plate}<br>路線: ${bus.route}`);
      busMarkers[plate] = marker;
    });
  } catch (err) {
    console.error("更新巴士位置失敗: ", err);
  }
}

// 每 5 秒更新一次
setInterval(updateBuses, 5000);
updateBuses();

