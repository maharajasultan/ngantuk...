/* =========================================================
   JagaMata — Pendeteksi Kantuk Touring
   Semua logika berjalan 100% di sisi klien (browser).
   ========================================================= */

// ---------- Konstanta deteksi ----------
const EAR_THRESHOLD = 0.23;        // di bawah ini dianggap mata tertutup
const CLOSED_DURATION_MS = 900;    // 0.9 detik mata tertutup terus-menerus = ngantuk
const VOICE_INTERVAL_MS = 4000;    // jeda pengulangan suara peringatan
const DEFAULT_ALARM_URL = 'https://actions.google.com/sounds/v1/alarms/alarm_clock.ogg';
const AUTO_RECENTER_DELAY_MS = 6000; // jeda sebelum peta otomatis dipusatkan lagi setelah digeser manual

// Index landmark mata pada MediaPipe Face Mesh (468 titik)
// urutan: [sudut1, atas1, atas2, sudut2, bawah1, bawah2]
const RIGHT_EYE = [33, 160, 158, 133, 153, 144];
const LEFT_EYE  = [362, 385, 387, 263, 373, 380];

// ---------- Referensi elemen DOM ----------
const originInput   = document.getElementById('originInput');
const destInput      = document.getElementById('destInput');
const suggestList    = document.getElementById('suggestList');
const btnLocate      = document.getElementById('btnLocate');
const btnSearch      = document.getElementById('btnSearch');
const btnRoute       = document.getElementById('btnRoute');
const routeInfo      = document.getElementById('routeInfo');
const routeDistance  = document.getElementById('routeDistance');
const routeDuration  = document.getElementById('routeDuration');

const videoEl        = document.getElementById('video');
const overlayCanvas  = document.getElementById('overlay');
const camEmpty       = document.getElementById('camEmpty');
const earValue       = document.getElementById('earValue');
const camWrapEl      = document.getElementById('camWrap');
const camFloating    = document.getElementById('camFloating');

const btnRecenter    = document.getElementById('btnRecenter');
const btnStopFloating = document.getElementById('btnStopFloating');
const appEl          = document.querySelector('.app');

const alarmUrlInput = document.getElementById('alarmUrlInput');
const btnTestSound  = document.getElementById('btnTestSound');

const btnStart       = document.getElementById('btnStart');
const btnStop        = document.getElementById('btnStop');

const statTimer      = document.getElementById('statTimer');
const statCount      = document.getElementById('statCount');

const alertBar        = document.getElementById('alertBar');
const alertBarText    = document.getElementById('alertBarText');
const statusPill      = document.getElementById('statusPill');
const statusPillText  = document.getElementById('statusPillText');

const reportModal      = document.getElementById('reportModal');
const reportDuration   = document.getElementById('reportDuration');
const reportCount      = document.getElementById('reportCount');
const reportConclusion = document.getElementById('reportConclusion');
const btnCloseReport   = document.getElementById('btnCloseReport');

// ---------- State aplikasi ----------
let map, originMarker, destMarker, routingControl;
let originLatLng = null;
let destLatLng = null;

let faceMesh = null;
let camera = null;

let audioCtx = null;
let voiceInterval = null;
const alarmAudio = new Audio();
alarmAudio.loop = true;
alarmAudio.preload = 'auto';

let liveMarker = null;
let watchId = null;
let followMap = true;
let autoRecenterTimer = null;

let eyeCloseStart = null;
let isDrowsyAlert = false;
let drowsyCount = 0;

let tripStartTime = null;
let timerInterval = null;

// =========================================================
// 1. PETA (Leaflet + OpenStreetMap)
// =========================================================
function initMap(){
  map = L.map('map', { zoomControl: true }).setView([-6.2088, 106.8456], 12); // default: Jakarta

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);
}

function detectOrigin(){
  if(!navigator.geolocation){
    alert('Browser ini tidak mendukung geolocation.');
    return;
  }
  btnLocate.disabled = true;
  navigator.geolocation.getCurrentPosition(async (pos)=>{
    originLatLng = { lat: pos.coords.latitude, lng: pos.coords.longitude };

    if(originMarker) map.removeLayer(originMarker);
    originMarker = L.marker(originLatLng).addTo(map).bindPopup('Asal (lokasi kamu)').openPopup();
    map.setView(originLatLng, 14);

    originInput.value = `${originLatLng.lat.toFixed(5)}, ${originLatLng.lng.toFixed(5)}`;

    // Reverse geocode ke nama lokasi (Nominatim, gratis, tanpa API key)
    try{
      const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${originLatLng.lat}&lon=${originLatLng.lng}`);
      const data = await res.json();
      if(data && data.display_name) originInput.value = data.display_name;
    }catch(err){
      console.warn('Reverse geocode gagal, memakai koordinat saja.', err);
    }

    btnLocate.disabled = false;
    checkRouteReady();
  }, (err)=>{
    btnLocate.disabled = false;
    alert('Gagal mendeteksi lokasi: ' + err.message);
  });
}

let searchDebounce = null;
function onDestInputChange(){
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(searchDestination, 500);
}

async function searchDestination(){
  const q = destInput.value.trim();
  if(q.length < 3){ suggestList.innerHTML = ''; return; }

  try{
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(q)}`);
    const results = await res.json();
    renderSuggestions(results);
  }catch(err){
    console.error('Pencarian tujuan gagal:', err);
  }
}

function renderSuggestions(results){
  suggestList.innerHTML = '';
  results.forEach(r=>{
    const li = document.createElement('li');
    li.textContent = r.display_name;
    li.addEventListener('click', ()=>{
      destLatLng = { lat: parseFloat(r.lat), lng: parseFloat(r.lon) };
      destInput.value = r.display_name;
      suggestList.innerHTML = '';

      if(destMarker) map.removeLayer(destMarker);
      destMarker = L.marker(destLatLng).addTo(map).bindPopup('Tujuan').openPopup();

      checkRouteReady();
    });
    suggestList.appendChild(li);
  });
}

function checkRouteReady(){
  btnRoute.disabled = !(originLatLng && destLatLng);
}

function buildRoute(){
  if(!originLatLng || !destLatLng) return;

  if(routingControl){ map.removeControl(routingControl); routingControl = null; }

  routingControl = L.Routing.control({
    waypoints: [
      L.latLng(originLatLng.lat, originLatLng.lng),
      L.latLng(destLatLng.lat, destLatLng.lng)
    ],
    lineOptions: { styles: [{ color: '#FFB020', weight: 5, opacity: 0.9 }] },
    router: L.Routing.osrmv1({ serviceUrl: 'https://router.project-osrm.org/route/v1' }),
    addWaypoints: false,
    draggableWaypoints: false,
    fitSelectedRoutes: true,
    show: true
  }).addTo(map);

  routingControl.on('routesfound', (e)=>{
    const r = e.routes[0];
    routeDistance.textContent = (r.summary.totalDistance / 1000).toFixed(1) + ' km';
    routeDuration.textContent = Math.round(r.summary.totalTime / 60) + ' menit';
    routeInfo.hidden = false;
  });

  routingControl.on('routingerror', ()=>{
    console.warn('Layanan routing OSRM gagal, menampilkan garis lurus sebagai cadangan.');
    L.polyline([originLatLng, destLatLng], { color: '#FFB020', weight: 4, dashArray: '6 6' }).addTo(map);
  });
}

function startLiveTracking(){
  if(!navigator.geolocation){
    console.warn('Geolocation tidak tersedia, peta tidak bisa mengikuti posisi.');
    return;
  }
  followMap = true;
  btnRecenter.hidden = true;

  watchId = navigator.geolocation.watchPosition((pos)=>{
    const latlng = { lat: pos.coords.latitude, lng: pos.coords.longitude };

    // Isi otomatis field "Asal" dari titik GPS pertama, jika belum diisi manual
    if(!originLatLng){
      originLatLng = latlng;
      originInput.value = `${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}`;
      checkRouteReady();
    }

    if(!liveMarker){
      liveMarker = L.marker(latlng, {
        icon: L.divIcon({ className: 'live-marker-icon', html: '<span class="live-marker-dot"></span>', iconSize: [16,16] })
      }).addTo(map);
    } else {
      liveMarker.setLatLng(latlng);
    }

    if(followMap){
      map.setView(latlng, Math.max(map.getZoom(), 16), { animate: true });
    }
  }, (err)=>{
    console.warn('Gagal melacak posisi live:', err.message);
  }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 10000 });
}

function recenterMap(){
  followMap = true;
  btnRecenter.hidden = true;
  if(autoRecenterTimer){
    clearTimeout(autoRecenterTimer);
    autoRecenterTimer = null;
  }
  if(liveMarker){
    map.setView(liveMarker.getLatLng(), Math.max(map.getZoom(), 16), { animate: true });
  }
}

function stopLiveTracking(){
  if(watchId !== null){
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  if(liveMarker){
    map.removeLayer(liveMarker);
    liveMarker = null;
  }
  if(autoRecenterTimer){
    clearTimeout(autoRecenterTimer);
    autoRecenterTimer = null;
  }
  btnRecenter.hidden = true;
}

// =========================================================
// 2. DETEKSI NGANTUK (MediaPipe Face Mesh + EAR)
// =========================================================
function initFaceMeshIfNeeded(){
  if(faceMesh) return;

  faceMesh = new FaceMesh({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`
  });
  faceMesh.setOptions({
    maxNumFaces: 1,
    refineLandmarks: true,
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5
  });
  faceMesh.onResults(handleFaceResults);
}

function distance(a, b){
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Eye Aspect Ratio: (|p2-p6| + |p3-p5|) / (2 * |p1-p4|)
function computeEAR(landmarks, idx, w, h){
  const p = idx.map(i => ({ x: landmarks[i].x * w, y: landmarks[i].y * h }));
  const vertical1   = distance(p[1], p[5]);
  const vertical2    = distance(p[2], p[4]);
  const horizontal   = distance(p[0], p[3]);
  return (vertical1 + vertical2) / (2 * horizontal);
}

function drawEyePoints(ctx, landmarks, idx, w, h, color){
  ctx.fillStyle = color;
  idx.forEach(i=>{
    const p = landmarks[i];
    ctx.beginPath();
    ctx.arc(p.x * w, p.y * h, 2.5, 0, Math.PI * 2);
    ctx.fill();
  });
}

function handleFaceResults(results){
  const w = videoEl.videoWidth || 480;
  const h = videoEl.videoHeight || 360;

  if(overlayCanvas.width !== w || overlayCanvas.height !== h){
    overlayCanvas.width = w;
    overlayCanvas.height = h;
  }
  const ctx = overlayCanvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);

  if(!results.multiFaceLandmarks || results.multiFaceLandmarks.length === 0){
    earValue.textContent = '-';
    return;
  }

  const landmarks = results.multiFaceLandmarks[0];
  const leftEAR  = computeEAR(landmarks, LEFT_EYE, w, h);
  const rightEAR = computeEAR(landmarks, RIGHT_EYE, w, h);
  const ear = (leftEAR + rightEAR) / 2;

  earValue.textContent = ear.toFixed(2);

  const dotColor = isDrowsyAlert ? '#FF4757' : '#3ECF8E';
  drawEyePoints(ctx, landmarks, LEFT_EYE, w, h, dotColor);
  drawEyePoints(ctx, landmarks, RIGHT_EYE, w, h, dotColor);

  evaluateDrowsiness(ear);
}

function evaluateDrowsiness(ear){
  const now = performance.now();

  if(ear < EAR_THRESHOLD){
    if(eyeCloseStart === null) eyeCloseStart = now;

    if(!isDrowsyAlert && (now - eyeCloseStart) >= CLOSED_DURATION_MS){
      isDrowsyAlert = true;
      drowsyCount += 1;
      statCount.textContent = drowsyCount;
      startAlarm();
      setAlertState(true);
    }
  } else {
    eyeCloseStart = null;
    if(isDrowsyAlert){
      isDrowsyAlert = false;
      stopAlarm();
      setAlertState(false);
    }
  }
}

function setAlertState(danger){
  if(danger){
    alertBar.dataset.state = 'danger';
    alertBarText.textContent = '⚠ TERDETEKSI MENGANTUK! Segera menepi & istirahat.';
    setStatusPill('alert', 'MENGANTUK');
  } else {
    alertBar.dataset.state = 'safe';
    alertBarText.textContent = 'Mata terpantau normal';
    if(tripStartTime) setStatusPill('active', 'TOURING');
  }
}

function setStatusPill(state, text){
  statusPill.dataset.state = state;
  statusPillText.textContent = text;
}

// =========================================================
// 3. ALARM (1 suara, sumbernya dari link/URL audio yang bisa diganti)
// =========================================================
function ensureAudioCtx(){
  // Dipakai untuk "membangunkan" audio di browser (butuh interaksi pengguna
  // pertama kali) sebelum elemen <audio> bisa diputar otomatis nanti.
  if(!audioCtx){
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if(audioCtx.state === 'suspended') audioCtx.resume();
}

function getAlarmUrl(){
  return alarmUrlInput.value.trim() || DEFAULT_ALARM_URL;
}

function speakAlert(text){
  if(!('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel(); // hentikan ucapan sebelumnya agar tidak menumpuk
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = 'id-ID';
  utter.rate = 1.05;
  utter.pitch = 1;
  utter.volume = 1;
  window.speechSynthesis.speak(utter);
}

function startAlarm(){
  ensureAudioCtx();

  const url = getAlarmUrl();
  if(alarmAudio.src !== url) alarmAudio.src = url;
  alarmAudio.loop = true;
  alarmAudio.currentTime = 0;
  alarmAudio.play().catch((err) => {
    console.warn('Gagal memutar link audio alarm. Cek link-nya di panel "Suara Alarm Ngantuk".', err);
  });

  speakAlert('Mata terdeteksi mengantuk. Segera menepi dan istirahat.');
  voiceInterval = setInterval(() => speakAlert('Mata terdeteksi mengantuk.'), VOICE_INTERVAL_MS);
}

function stopAlarm(){
  alarmAudio.pause();
  alarmAudio.currentTime = 0;

  if(voiceInterval){
    clearInterval(voiceInterval);
    voiceInterval = null;
  }
  if('speechSynthesis' in window) window.speechSynthesis.cancel();
}

function testAlarmSound(){
  ensureAudioCtx();
  const tester = new Audio(getAlarmUrl());
  tester.play().catch(() => {
    alert('Gagal memutar link audio. Pastikan link valid, format didukung browser (mp3/ogg/wav), dan bisa diakses publik.');
  });
}

// =========================================================
// 4. KONTROL TOURING (start / stop, timer, laporan akhir)
// =========================================================
// =========================================================
// Widget kamera kecil yang bisa diseret (muncul saat touring aktif)
// =========================================================
function moveCameraToFloating(){
  camFloating.appendChild(camWrapEl);
  camWrapEl.classList.add('camwrap--floating');
  camFloating.hidden = false;
}

function restoreCameraToSidebar(){
  const camRowEl      = document.querySelector('.camrow');
  const earReadoutEl  = document.querySelector('.ear-readout');
  camWrapEl.classList.remove('camwrap--floating');
  if(camRowEl){
    if(earReadoutEl) camRowEl.insertBefore(camWrapEl, earReadoutEl);
    else camRowEl.appendChild(camWrapEl);
  }
  camFloating.hidden = true;
  // reset posisi supaya kembali ke posisi awal saat touring berikutnya dimulai
  camFloating.style.left = '';
  camFloating.style.top = '';
}

let isDraggingCam = false;
let dragOffsetX = 0;
let dragOffsetY = 0;

function camDragStart(e){
  isDraggingCam = true;
  const point = e.touches ? e.touches[0] : e;
  const rect = camFloating.getBoundingClientRect();
  dragOffsetX = point.clientX - rect.left;
  dragOffsetY = point.clientY - rect.top;
  if(e.cancelable) e.preventDefault();
}

function camDragMove(e){
  if(!isDraggingCam) return;
  const point = e.touches ? e.touches[0] : e;
  let newLeft = point.clientX - dragOffsetX;
  let newTop  = point.clientY - dragOffsetY;

  const maxLeft = window.innerWidth - camFloating.offsetWidth - 4;
  const maxTop  = window.innerHeight - camFloating.offsetHeight - 4;
  newLeft = Math.max(4, Math.min(maxLeft, newLeft));
  newTop  = Math.max(4, Math.min(maxTop, newTop));

  camFloating.style.left = newLeft + 'px';
  camFloating.style.top  = newTop + 'px';
  if(e.cancelable) e.preventDefault();
}

function camDragEnd(){
  isDraggingCam = false;
}

function unlockAlarmAudio(){
  // Trik standar: mainkan sebentar (dalam keadaan muted) tepat saat ada
  // gestur klik pengguna, supaya browser mengizinkan alarmAudio.play()
  // dipanggil lagi secara otomatis nanti oleh evaluateDrowsiness() tanpa
  // gestur baru.
  const url = getAlarmUrl();
  if(alarmAudio.src !== url) alarmAudio.src = url;
  alarmAudio.loop = true;
  alarmAudio.muted = true;
  const p = alarmAudio.play();
  if(p && p.catch) p.catch(() => {});
  setTimeout(() => {
    alarmAudio.pause();
    alarmAudio.currentTime = 0;
    alarmAudio.muted = false;
  }, 60);
}

async function startTouring(){
  initFaceMeshIfNeeded();
  unlockAlarmAudio();

  try{
    camera = new Camera(videoEl, {
      onFrame: async () => { await faceMesh.send({ image: videoEl }); },
      width: 480,
      height: 360
    });
    await camera.start();
  }catch(err){
    alert('Gagal mengakses kamera. Pastikan izin kamera sudah diberikan.\n\nDetail: ' + err.message);
    return;
  }

  camEmpty.hidden = true;
  drowsyCount = 0;
  statCount.textContent = '0';
  tripStartTime = Date.now();
  timerInterval = setInterval(updateTimerUI, 1000);
  updateTimerUI();

  startLiveTracking();

  btnStart.hidden = true;
  btnStop.hidden = false;
  setStatusPill('active', 'TOURING');
  setAlertState(false);

  // Mode fokus peta: sembunyikan seluruh panel kontrol, pindahkan kamera
  // jadi widget kecil yang bisa diseret, tampilkan tombol "Selesai" kecil.
  appEl.classList.add('touring-active');
  moveCameraToFloating();
  btnStopFloating.hidden = false;
}

function stopTouring(){
  if(camera){
    camera.stop();
    camera = null;
  }
  if(videoEl.srcObject){
    videoEl.srcObject.getTracks().forEach(t => t.stop());
    videoEl.srcObject = null;
  }
  camEmpty.hidden = false;

  clearInterval(timerInterval);
  timerInterval = null;

  stopLiveTracking();
  stopAlarm();
  isDrowsyAlert = false;
  eyeCloseStart = null;
  setAlertState(false);

  const durationMs = Date.now() - (tripStartTime || Date.now());
  showReport(durationMs, drowsyCount);

  btnStart.hidden = false;
  btnStop.hidden = true;
  setStatusPill('idle', 'SELESAI');

  appEl.classList.remove('touring-active');
  restoreCameraToSidebar();
  btnStopFloating.hidden = true;
}

function updateTimerUI(){
  const elapsed = Date.now() - tripStartTime;
  const totalSec = Math.floor(elapsed / 1000);
  const mm = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const ss = String(totalSec % 60).padStart(2, '0');
  statTimer.textContent = `${mm}:${ss}`;
}

function showReport(durationMs, count){
  const minutes = Math.max(1, Math.round(durationMs / 60000));
  reportDuration.textContent = minutes + ' menit';
  reportCount.textContent = count + ' kali';

  let conclusion;
  if(count === 0){
    conclusion = 'Mantap! Sepanjang perjalanan matamu terpantau segar. Tetap jaga kondisi ini di touring berikutnya.';
  } else if(count <= 2){
    conclusion = 'Terdeteksi sedikit tanda kantuk. Sesekali berhenti untuk peregangan dan minum air putih ya.';
  } else if(count <= 5){
    conclusion = 'Kantuk cukup sering terdeteksi selama perjalanan. Disarankan berhenti di rest area terdekat untuk istirahat sebelum lanjut touring.';
  } else {
    conclusion = 'Level kantuk tinggi terdeteksi berkali-kali. Demi keselamatanmu, sangat disarankan berhenti dan istirahat cukup sebelum melanjutkan perjalanan.';
  }

  reportConclusion.textContent = conclusion;
  reportModal.hidden = false;
}

// =========================================================
// 5. EVENT LISTENERS & INIT
// =========================================================
document.addEventListener('DOMContentLoaded', () => {
  initMap();

  btnLocate.addEventListener('click', detectOrigin);
  destInput.addEventListener('input', onDestInputChange);
  btnSearch.addEventListener('click', searchDestination);
  btnRoute.addEventListener('click', buildRoute);

  btnStart.addEventListener('click', startTouring);
  btnStop.addEventListener('click', stopTouring);

  btnCloseReport.addEventListener('click', () => { reportModal.hidden = true; });

  btnTestSound.addEventListener('click', testAlarmSound);

  btnStopFloating.addEventListener('click', stopTouring);

  // Drag widget kamera: mouse (desktop) & touch (mobile)
  camFloating.addEventListener('mousedown', camDragStart);
  window.addEventListener('mousemove', camDragMove);
  window.addEventListener('mouseup', camDragEnd);
  camFloating.addEventListener('touchstart', camDragStart, { passive: false });
  window.addEventListener('touchmove', camDragMove, { passive: false });
  window.addEventListener('touchend', camDragEnd);

  // Saat peta digeser manual oleh pengguna, hentikan mode "mengikuti" otomatis
  // sementara, lalu jadwalkan peta untuk otomatis kembali terpusat ke posisi
  // kita kalau tidak digeser lagi dalam beberapa detik.
  map.on('dragstart', () => {
    if(watchId !== null){
      followMap = false;
      btnRecenter.hidden = false;

      if(autoRecenterTimer) clearTimeout(autoRecenterTimer);
      autoRecenterTimer = setTimeout(recenterMap, AUTO_RECENTER_DELAY_MS);
    }
  });

  btnRecenter.addEventListener('click', recenterMap);
});