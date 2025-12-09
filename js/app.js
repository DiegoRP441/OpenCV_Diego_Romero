(() => {
  // Lightweight client logger: buffers in localStorage and sends to /api/log
  const logger = (() => {
    const key = 'logger_buffer_v1';
    const load = () => { try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch { return []; } };
    const save = (buf) => { try { localStorage.setItem(key, JSON.stringify(buf)); } catch {} };
    const post = async (events) => {
      try {
        await fetch('/api/log', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ events, context: { ua: navigator.userAgent } })
        });
        return true;
      } catch {
        return false;
      }
    };
    let buffer = load();
    const log = (type, data = {}) => {
      const evt = { type, data, ts: Date.now() };
      buffer.push(evt); save(buffer);
    };
    const flush = async () => {
      if (!buffer.length) return;
      const toSend = buffer.slice();
      const ok = await post(toSend);
      if (ok) { buffer = []; save(buffer); }
      return ok;
    };
    setInterval(flush, 5000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
    window.addEventListener('error', (e) => log('error', { message: e.message, stack: e.error?.stack }));
    window.addEventListener('unhandledrejection', (e) => log('unhandledrejection', { reason: String(e.reason) }));
    return { log, flush };
  })();

  // Simple session id for visit tracking
  const sessionId = (() => {
    const key = 'session_id_v1';
    let id = sessionStorage.getItem(key);
    if (!id) {
      const arr = new Uint8Array(16);
      crypto.getRandomValues(arr);
      id = Array.from(arr).map(b => b.toString(16).padStart(2,'0')).join('');
      sessionStorage.setItem(key, id);
    }
    return id;
  })();

  // Registrar entrada de sesión
  logger.log('app_enter', { sessionId, ts: Date.now(), ref: document.referrer || '', tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown' });
  // Enviar de inmediato en el primer load
  (async () => { try { await logger.flush(); } catch {} })();

  const state = {
    mode: 'faces',
    points: [],
    webcamOn: false,
    stream: null,
    cascadeLoaded: false,
    classifier: null,
    templateMat: null,
    rafId: null,
    dnnLoaded: false,
    dnnNet: null,
    dnnClasses: ['background','aeroplane','bicycle','bird','boat','bottle','bus','car','cat','chair','cow','diningtable','dog','horse','motorbike','person','pottedplant','sheep','sofa','train','tvmonitor'],
    objectsEngine: 'dnn',
    tfModel: null,
    tfDetections: [],
    tfPending: false,
    tfDetInterval: 250,
    tfLastDet: 0,
    tfCanvas: null,
    // teclado por mano
    kbdText: '',
    kbdPressCooldown: 400,
    kbdLastPress: 0,
    kbdLayout: [
      ['Q','W','E','R','T','Y','U','I','O','P'],
      ['A','S','D','F','G','H','J','K','L'],
      ['Z','X','C','V','B','N','M','ESP','BOR']
    ],
    hands: null,
    handLandmarks: null,
    handDetInterval: 100,
    handLastDet: 0,
    handPending: false,
    faceCountTotal: 0,
  };

  const els = {
    cvStatus: document.getElementById('cvStatus'),
    faceCount: document.getElementById('faceCount'),
    tabs: Array.from(document.querySelectorAll('.tab-btn')),
    panels: Array.from(document.querySelectorAll('.panel')),
    imageInput: document.getElementById('imageInput'),
    templateInput: document.getElementById('templateInput'),
    webcamToggle: document.getElementById('webcamToggle'),
    video: document.getElementById('video'),
    inCanvas: document.getElementById('inputCanvas'),
    outCanvas: document.getElementById('outputCanvas'),
    facesLoad: document.getElementById('facesLoad'),
    perspReset: document.getElementById('perspReset'),
    objectsLoad: document.getElementById('objectsLoad'),
    // teclado
    kbdText: document.getElementById('kbdText'),
  };

  const controls = {
    // Filters
    fltGray: document.getElementById('fltGray'),
    fltGauss: document.getElementById('fltGauss'),
    fltMedian: document.getElementById('fltMedian'),
    fltBilateral: document.getElementById('fltBilateral'),
    fltClahe: document.getElementById('fltClahe'),
    // Edges
    edgeT1: document.getElementById('edgeT1'),
    edgeT2: document.getElementById('edgeT2'),
    // Threshold
    thrType: document.getElementById('thrType'),
    thrVal: document.getElementById('thrVal'),
    thrBlock: document.getElementById('thrBlock'),
    thrC: document.getElementById('thrC'),
    // Morph
    morphOp: document.getElementById('morphOp'),
    morphK: document.getElementById('morphK'),
    morphIter: document.getElementById('morphIter'),
    // Contours
    cntMinArea: document.getElementById('cntMinArea'),
    cntThr: document.getElementById('cntThr'),
    // Hough
    houghMode: document.getElementById('houghMode'),
    houghP1: document.getElementById('houghP1'),
    houghP2: document.getElementById('houghP2'),
    // Features
    featMax: document.getElementById('featMax'),
    // Color HSV
    hMin: document.getElementById('hMin'),
    hMax: document.getElementById('hMax'),
    sMin: document.getElementById('sMin'),
    sMax: document.getElementById('sMax'),
    vMin: document.getElementById('vMin'),
    vMax: document.getElementById('vMax'),
    // Perspective
    perspW: document.getElementById('perspW'),
    perspH: document.getElementById('perspH'),
    // Template
    tmplMethod: document.getElementById('tmplMethod'),
    // Objects
    objConf: document.getElementById('objConf'),
    objEngine: document.getElementById('objEngine'),
  };

  // Tab switching
  els.tabs.forEach(btn => {
    btn.addEventListener('click', () => {
      els.tabs.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.mode = btn.dataset.mode;
      els.panels.forEach(p => p.classList.remove('active'));
      const panel = document.getElementById('panel-' + state.mode);
      if (panel) panel.classList.add('active');
    });
  });

  // Image upload
  els.imageInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const img = new Image();
    img.onload = () => {
      const ctx = els.inCanvas.getContext('2d');
      const maxW = els.inCanvas.width, maxH = els.inCanvas.height;
      let w = img.width, h = img.height;
      const scale = Math.min(maxW / w, maxH / h);
      w = Math.round(w * scale); h = Math.round(h * scale);
      ctx.clearRect(0, 0, maxW, maxH);
      ctx.drawImage(img, 0, 0, w, h);
      processFrame();
    };
    img.src = URL.createObjectURL(file);
  });

  // Template upload
  els.templateInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const img = new Image();
    img.onload = () => {
      const tmpCanvas = document.createElement('canvas');
      tmpCanvas.width = img.width; tmpCanvas.height = img.height;
      tmpCanvas.getContext('2d').drawImage(img, 0, 0);
      const templ = cv.imread(tmpCanvas);
      state.templateMat && state.templateMat.delete();
      state.templateMat = templ;
      processFrame();
    };
    img.src = URL.createObjectURL(file);
  });

  // Webcam toggle
  els.webcamToggle.addEventListener('click', async () => {
    if (!state.webcamOn) {
      try {
        state.stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
        els.video.srcObject = state.stream;
        await els.video.play();
        els.video.classList.remove('hidden');
        state.webcamOn = true;
        logger.log('webcam_on');
        loop();
      } catch (err) {
        logger.log('webcam_error', { message: err.message });
        alert('No se pudo activar la webcam: ' + err.message);
      }
    } else {
      cancelAnimationFrame(state.rafId);
      els.video.pause();
      els.video.srcObject = null;
      state.stream?.getTracks().forEach(t => t.stop());
      state.stream = null;
      els.video.classList.add('hidden');
      state.webcamOn = false;
      logger.log('webcam_off');
    }
  });

  // Perspective reset
  els.perspReset.addEventListener('click', () => {
    state.points = [];
  });

  // Collect points on input canvas
  els.inCanvas.addEventListener('click', (e) => {
    if (state.mode !== 'perspective') return;
    const rect = els.inCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (state.points.length < 4) {
      state.points.push({ x, y });
    }
    processFrame();
  });

  // Controls change triggers re-process
  document.querySelectorAll('.controls input, .controls select, .controls button').forEach(el => {
    el.addEventListener('input', () => processFrame());
    el.addEventListener('change', () => processFrame());
  });

  // OpenCV init status
  const setCvStatus = (msg) => {
    els.cvStatus.textContent = 'OpenCV: ' + msg;
    logger.log('opencv_status', { msg });
  };

  // Load Haar cascade
  els.facesLoad.addEventListener('click', async () => {
    try {
      setCvStatus('descargando cascade...');
      const url = 'https://raw.githubusercontent.com/opencv/opencv/master/data/haarcascades/haarcascade_frontalface_default.xml';
      const resp = await fetch(url);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const text = await resp.text();
      const fname = 'haarcascade_frontalface_default.xml';
      cv.FS_createDataFile('/', fname, text, true, false);
      state.classifier = new cv.CascadeClassifier();
      state.classifier.load(fname);
      state.cascadeLoaded = true;
      setCvStatus('cascade listo');
      processFrame();
    } catch (err) {
      setCvStatus('error cascade');
      alert('Error cargando cascade: ' + err.message);
    }
  });

  // Load DNN model (MobileNet-SSD)
  els.objectsLoad.addEventListener('click', async () => {
    try {
      const engine = controls.objEngine.value;
      if (engine === 'tfjs') {
        setCvStatus('cargando COCO-SSD...');
        if (window.cocoSsd && window.tf) {
          try {
            await tf.setBackend('cpu');
            await tf.ready();
          } catch (e) { console.warn('No se pudo fijar backend TF', e); }
          state.tfModel = await window.cocoSsd.load();
          state.objectsEngine = 'tfjs';
          // preparar canvas reducido
          if (!state.tfCanvas) {
            state.tfCanvas = document.createElement('canvas');
            state.tfCanvas.width = 320; state.tfCanvas.height = 240;
          }
          setCvStatus('COCO-SSD listo');
        } else {
          throw new Error('coco-ssd/TF no disponible');
        }
      } else {
        if (!cv.readNetFromCaffe) {
          throw new Error('OpenCV.js sin módulo DNN');
        }
        setCvStatus('descargando modelo DNN...');
        const protoUrl = 'https://raw.githubusercontent.com/chuanqi305/MobileNet-SSD/master/MobileNetSSD_deploy.prototxt';
        const modelUrl = 'https://raw.githubusercontent.com/chuanqi305/MobileNet-SSD/master/MobileNetSSD_deploy.caffemodel';
        const [protoResp, modelResp] = await Promise.all([
          fetch(protoUrl),
          fetch(modelUrl)
        ]);
        if (!protoResp.ok || !modelResp.ok) throw new Error('HTTP ' + protoResp.status + '/' + modelResp.status);
        const protoText = await protoResp.text();
        const modelBuf = await modelResp.arrayBuffer();
        const protoName = 'MobileNetSSD_deploy.prototxt';
        const modelName = 'MobileNetSSD_deploy.caffemodel';
        cv.FS_createDataFile('/', protoName, protoText, true, false);
        cv.FS_createDataFile('/', modelName, new Uint8Array(modelBuf), true, false);
        state.dnnNet = cv.readNetFromCaffe(protoName, modelName);
        state.dnnLoaded = true;
        state.objectsEngine = 'dnn';
        setCvStatus('modelo DNN listo');
      }
      processFrame();
    } catch (err) {
      setCvStatus('error cargando objetos');
      alert('Error cargando motor: ' + err.message + '\nSugerencia: selecciona TF.js COCO-SSD si DNN no está disponible.');
    }
  });

  // Main loop for webcam
  function loop() {
    const ctx = els.inCanvas.getContext('2d');
    ctx.drawImage(els.video, 0, 0, els.inCanvas.width, els.inCanvas.height);
    processFrame();
    state.rafId = requestAnimationFrame(loop);
  }

  // Core processing
  function processFrame() {
    if (!window.cv || !cv.Mat) return;
    let src = cv.imread(els.inCanvas);
    let dst = new cv.Mat();

    try {
      switch (state.mode) {
        case 'faces':
          dst = detectFaces(src);
          break;
        case 'threshold':
          dst = applyThreshold(src);
          break;
        case 'contours':
          dst = drawContours(src);
          break;
        case 'edges':
          dst = applyEdges(src);
          break;
        default:
          dst = src.clone();
      }
      cv.imshow(els.outCanvas, dst);
    } catch (err) {
      console.error(err);
    } finally {
      src.delete();
      dst.delete();
    }
  }

  // Mode implementations
  function applyFilters(src) {
    let mat = src.clone();
    try {
      if (controls.fltGray.checked) {
        let gray = new cv.Mat();
        cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);
        mat.delete(); mat = gray;
      }
      let kG = parseInt(controls.fltGauss.value, 10) | 0; if (kG % 2 === 0) kG += 1;
      if (kG > 1) {
        let g = new cv.Mat();
        cv.GaussianBlur(mat, g, new cv.Size(kG, kG), 0, 0, cv.BORDER_DEFAULT);
        mat.delete(); mat = g;
      }
      let kM = parseInt(controls.fltMedian.value, 10) | 0; if (kM % 2 === 0) kM += 1;
      if (kM > 1) {
        let m = new cv.Mat();
        cv.medianBlur(mat, m, kM);
        mat.delete(); mat = m;
      }
      let d = parseInt(controls.fltBilateral.value, 10) | 0;
      if (d > 1) {
        let b = new cv.Mat();
        cv.bilateralFilter(mat, b, d, d * 2, d / 2);
        mat.delete(); mat = b;
      }
      if (controls.fltClahe.checked && mat.channels() === 1 && cv.createCLAHE) {
        const clahe = cv.createCLAHE(2.0, new cv.Size(8, 8));
        let c = new cv.Mat();
        clahe.apply(mat, c); mat.delete(); mat = c;
      }
    } catch (e) { console.warn('filters error', e); }
    return mat;
  }

  function applyEdges(src) {
    let gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    let edges = new cv.Mat();
    const t1 = parseInt(controls.edgeT1.value, 10), t2 = parseInt(controls.edgeT2.value, 10);
    cv.Canny(gray, edges, t1, t2);
    gray.delete();
    return edges;
  }

  function applyThreshold(src) {
    let gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    let dst = new cv.Mat();
    const type = controls.thrType.value;
    const val = parseInt(controls.thrVal.value, 10);
    if (type === 'adaptive_mean' || type === 'adaptive_gaussian') {
      const blockSize = parseInt(controls.thrBlock.value, 10);
      const C = parseInt(controls.thrC.value, 10);
      const adaptiveMethod = type === 'adaptive_mean' ? cv.ADAPTIVE_THRESH_MEAN_C : cv.ADAPTIVE_THRESH_GAUSSIAN_C;
      cv.adaptiveThreshold(gray, dst, 255, adaptiveMethod, cv.THRESH_BINARY, blockSize, C);
    } else {
      const map = {
        binary: cv.THRESH_BINARY,
        binary_inv: cv.THRESH_BINARY_INV,
        trunc: cv.THRESH_TRUNC,
        tozero: cv.THRESH_TOZERO,
        tozero_inv: cv.THRESH_TOZERO_INV,
      };
      cv.threshold(gray, dst, val, 255, map[type] || cv.THRESH_BINARY);
    }
    gray.delete();
    return dst;
  }

  function applyMorph(src) {
    let gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    let bin = new cv.Mat();
    cv.threshold(gray, bin, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    let dst = new cv.Mat();
    const k = parseInt(controls.morphK.value, 10);
    const it = parseInt(controls.morphIter.value, 10);
    const op = controls.morphOp.value;
    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(k, k));
    if (op === 'erode') cv.erode(bin, dst, kernel, new cv.Point(-1, -1), it);
    else if (op === 'dilate') cv.dilate(bin, dst, kernel, new cv.Point(-1, -1), it);
    else if (op === 'open') cv.morphologyEx(bin, dst, cv.MORPH_OPEN, kernel, new cv.Point(-1, -1), it);
    else if (op === 'close') cv.morphologyEx(bin, dst, cv.MORPH_CLOSE, kernel, new cv.Point(-1, -1), it);
    gray.delete(); bin.delete(); kernel.delete();
    return dst;
  }

  function drawContours(src) {
    let gray = new cv.Mat(); cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    let bw = new cv.Mat(); cv.threshold(gray, bw, parseInt(controls.cntThr.value, 10), 255, cv.THRESH_BINARY);
    let contours = new cv.MatVector(); let hierarchy = new cv.Mat();
    cv.findContours(bw, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    let out = src.clone();
    const minArea = parseInt(controls.cntMinArea.value, 10);
    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const area = cv.contourArea(cnt);
      if (area < minArea) { cnt.delete(); continue; }
      const rect = cv.boundingRect(cnt);
      cv.rectangle(out, new cv.Point(rect.x, rect.y), new cv.Point(rect.x+rect.width, rect.y+rect.height), new cv.Scalar(0,255,0,255), 2);
      cv.drawContours(out, contours, i, new cv.Scalar(255,0,0,255), 1);
      cnt.delete();
    }
    gray.delete(); bw.delete(); hierarchy.delete(); contours.delete();
    return out;
  }

  function applyHough(src) {
    let gray = new cv.Mat(); cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(5,5), 1, 1, cv.BORDER_DEFAULT);
    let color = src.clone();
    const mode = controls.houghMode.value; const p1 = parseInt(controls.houghP1.value, 10); const p2 = parseInt(controls.houghP2.value, 10);
    if (mode === 'lines') {
      let edges = new cv.Mat(); cv.Canny(gray, edges, 50, 150);
      let lines = new cv.Mat();
      cv.HoughLinesP(edges, lines, 1, Math.PI/180, p1, 30, p2);
      for (let i = 0; i < lines.rows; ++i) {
        let [x1,y1,x2,y2] = lines.intPtr(i);
        cv.line(color, new cv.Point(x1,y1), new cv.Point(x2,y2), new cv.Scalar(255,255,0,255), 2);
      }
      edges.delete(); lines.delete();
    } else {
      let circles = new cv.Mat();
      cv.HoughCircles(gray, circles, cv.HOUGH_GRADIENT, 1, 20, p1, p2, 10, 0);
      for (let i = 0; i < circles.cols; ++i) {
        const x = circles.data32F[i*3];
        const y = circles.data32F[i*3+1];
        const r = circles.data32F[i*3+2];
        cv.circle(color, new cv.Point(x,y), r, new cv.Scalar(0,255,255,255), 2);
      }
      circles.delete();
    }
    gray.delete();
    return color;
  }

  function drawFeatures(src) {
    let gray = new cv.Mat(); cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    let out = src.clone();
    try {
      const max = parseInt(controls.featMax.value, 10);
      // Use ORB if available, else FAST
      if (cv.ORB) {
        const orb = new cv.ORB(max);
        const keypoints = new cv.KeyPointVector();
        orb.detect(gray, keypoints);
        // Draw keypoints manually
        for (let i = 0; i < keypoints.size(); i++) {
          const kp = keypoints.get(i);
          cv.circle(out, new cv.Point(kp.pt.x, kp.pt.y), 3, new cv.Scalar(255, 0, 255, 255), -1);
        }
        keypoints.delete();
      } else {
        const fast = new cv.FastFeatureDetector(10);
        const kps = new cv.KeyPointVector(); fast.detect(gray, kps);
        for (let i = 0; i < kps.size(); i++) {
          const kp = kps.get(i);
          cv.circle(out, new cv.Point(kp.pt.x, kp.pt.y), 3, new cv.Scalar(255, 0, 255, 255), -1);
        }
        kps.delete();
      }
    } catch (e) { console.warn('features error', e); }
    gray.delete();
    return out;
  }

  function maskHSV(src) {
    let hsv = new cv.Mat(); cv.cvtColor(src, hsv, cv.COLOR_RGBA2RGB); cv.cvtColor(hsv, hsv, cv.COLOR_RGB2HSV);
    const low = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [parseInt(controls.hMin.value,10), parseInt(controls.sMin.value,10), parseInt(controls.vMin.value,10), 0]);
    const high = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [parseInt(controls.hMax.value,10), parseInt(controls.sMax.value,10), parseInt(controls.vMax.value,10), 255]);
    let mask = new cv.Mat();
    cv.inRange(hsv, low, high, mask);
    let result = new cv.Mat();
    cv.bitwise_and(src, src, result, mask);
    hsv.delete(); low.delete(); high.delete(); mask.delete();
    return result;
  }

  function warpPerspective(src) {
    const pts = state.points;
    let out = new cv.Mat();
    if (pts.length === 4) {
      const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [pts[0].x, pts[0].y, pts[1].x, pts[1].y, pts[2].x, pts[2].y, pts[3].x, pts[3].y]);
      const w = parseInt(controls.perspW.value, 10), h = parseInt(controls.perspH.value, 10);
      const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0,0, w,0, w,h, 0,h]);
      const M = cv.getPerspectiveTransform(srcTri, dstTri);
      cv.warpPerspective(src, out, M, new cv.Size(w,h));
      srcTri.delete(); dstTri.delete(); M.delete();
    } else {
      out = src.clone();
      // Draw selected points
      pts.forEach(p => cv.circle(out, new cv.Point(p.x, p.y), 4, new cv.Scalar(0, 255, 0, 255), -1));
    }
    return out;
  }

  function templateMatch(src) {
    if (!state.templateMat) return src.clone();
    let gray = new cv.Mat(); cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    let templG = new cv.Mat(); cv.cvtColor(state.templateMat, templG, cv.COLOR_RGBA2GRAY);
    let result = new cv.Mat();
    const method = parseInt(controls.tmplMethod.value, 10);
    cv.matchTemplate(gray, templG, result, method);
    const mm = cv.minMaxLoc(result);
    let out = src.clone();
    let loc = (method === cv.TM_SQDIFF || method === cv.TM_SQDIFF_NORMED) ? mm.minLoc : mm.maxLoc;
    const rect = { x: loc.x, y: loc.y, w: templG.cols, h: templG.rows };
    cv.rectangle(out, new cv.Point(rect.x, rect.y), new cv.Point(rect.x+rect.w, rect.y+rect.h), new cv.Scalar(0, 255, 0, 255), 2);
    gray.delete(); templG.delete(); result.delete();
    return out;
  }

  function detectFaces(src) {
    let out = src.clone();
    if (!state.cascadeLoaded || !state.classifier) return out;
    let gray = new cv.Mat(); cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    let faces = new cv.RectVector(); let numDetections = new cv.IntVector();
    state.classifier.detectMultiScale(gray, faces, 1.1, 3, 0, new cv.Size(30, 30), new cv.Size());
    const count = faces.size();
    for (let i = 0; i < count; i++) {
      const face = faces.get(i);
      cv.rectangle(out, new cv.Point(face.x, face.y), new cv.Point(face.x + face.width, face.y + face.height), new cv.Scalar(255, 0, 0, 255), 2);
    }
    // actualizar contador total y UI
    if (count > 0) {
      state.faceCountTotal += count;
      if (els.faceCount) els.faceCount.textContent = 'Personas: ' + state.faceCountTotal;
      logger.log('faces_detected', { count, total: state.faceCountTotal });
    }
    gray.delete(); faces.delete(); numDetections.delete();
    return out;
  }

  function detectObjects(src) {
    // TF.js COCO-SSD engine
    if (controls.objEngine.value === 'tfjs' && state.tfModel) {
      let out = src.clone();
      // programar detección a ritmo limitado
      const now = Date.now();
      if (!state.tfPending && now - state.tfLastDet >= state.tfDetInterval) {
        state.tfPending = true; state.tfLastDet = now;
        try {
          const ctx = state.tfCanvas.getContext('2d');
          // dibujar frame reducido para detección
          ctx.drawImage(els.inCanvas, 0, 0, state.tfCanvas.width, state.tfCanvas.height);
          state.tfModel.detect(state.tfCanvas).then(dets => {
            state.tfDetections = dets;
            state.tfPending = false;
            // re-render para dibujar nuevas cajas
            processFrame();
          }).catch(err => {
            console.warn('tfjs detect error', err);
            state.tfPending = false;
          });
        } catch (e) { console.warn('tfjs canvas error', e); state.tfPending = false; }
      }
      const confMin = parseInt(controls.objConf.value, 10) / 100.0;
      for (const d of state.tfDetections) {
        if (d.score < confMin) continue;
        const [x, y, w, h] = d.bbox;
        cv.rectangle(out, new cv.Point(x, y), new cv.Point(x + w, y + h), new cv.Scalar(0, 200, 255, 255), 2);
        cv.putText(out, `${d.class} ${(d.score*100).toFixed(1)}%`, new cv.Point(x, Math.max(0, y-6)), cv.FONT_HERSHEY_SIMPLEX, 0.5, new cv.Scalar(0,200,255,255), 1);
      }
      return out;
    }

    // OpenCV DNN engine
    if (state.dnnLoaded && state.dnnNet) {
      const confMin = parseInt(controls.objConf.value, 10) / 100.0;
      let blob = cv.blobFromImage(src, 0.007843, new cv.Size(300, 300), new cv.Scalar(127.5,127.5,127.5,127.5), false, false);
      state.dnnNet.setInput(blob);
      let outDet = state.dnnNet.forward();
      let out = src.clone();
      const data = outDet.data32F;
      const w = src.cols, h = src.rows;
      for (let i = 0; i < data.length; i += 7) {
        const confidence = data[i + 2];
        if (confidence < confMin) continue;
        const classId = data[i + 1] | 0;
        const x1 = Math.round(data[i + 3] * w);
        const y1 = Math.round(data[i + 4] * h);
        const x2 = Math.round(data[i + 5] * w);
        const y2 = Math.round(data[i + 6] * h);
        const label = state.dnnClasses[classId] || ('id ' + classId);
        cv.rectangle(out, new cv.Point(x1, y1), new cv.Point(x2, y2), new cv.Scalar(0, 255, 0, 255), 2);
        cv.putText(out, `${label} ${(confidence*100).toFixed(1)}%`, new cv.Point(x1, Math.max(0, y1-6)), cv.FONT_HERSHEY_SIMPLEX, 0.5, new cv.Scalar(0,255,0,255), 1);
      }
      blob.delete(); outDet.delete();
      return out;
    }

    // HOG people detector fallback
    let out = src.clone();
    try {
      const hog = new cv.HOGDescriptor();
      hog.setSVMDetector(cv.HOGDescriptor.getDefaultPeopleDetector());
      // usar imagen en escala de grises para HOG
      const gray = new cv.Mat();
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      const found = new cv.RectVector();
      // parámetros razonables para estabilidad
      const winStride = new cv.Size(8, 8);
      const padding = new cv.Size(32, 32);
      hog.detectMultiScale(gray, found, 0.0, winStride, padding, 1.05, 2);
      for (let i = 0; i < found.size(); i++) {
        const r = found.get(i);
        cv.rectangle(out, new cv.Point(r.x, r.y), new cv.Point(r.x + r.width, r.y + r.height), new cv.Scalar(255, 255, 0, 255), 2);
        cv.putText(out, 'person', new cv.Point(r.x, Math.max(0, r.y-6)), cv.FONT_HERSHEY_SIMPLEX, 0.5, new cv.Scalar(255,255,0,255), 1);
      }
      hog.delete(); found.delete(); gray.delete(); winStride.delete(); padding.delete();
    } catch (e) { console.warn('HOG error', e); }
    return out;
  }

  // Hand keyboard (MediaPipe Hands)
  function initHands() {
    try {
      if (state.hands || !window.Hands) return;
      state.hands = new window.Hands({ locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}` });
      state.hands.setOptions({
        maxHands: 1,
        modelComplexity: 0,
        minDetectionConfidence: 0.6,
        minTrackingConfidence: 0.6,
      });
      state.hands.onResults((res) => {
        if (res.multiHandLandmarks && res.multiHandLandmarks.length > 0) {
          state.handLandmarks = res.multiHandLandmarks[0];
        } else {
          state.handLandmarks = null;
        }
      });
    } catch (e) { console.warn('initHands error', e); }
  }

  function drawKeyboard(src) {
    initHands();
    let out = src.clone();
    const w = out.cols, h = out.rows;

    // ejecutar detección a ritmo limitado si webcam está activa
    if (state.webcamOn && state.hands) {
      const now = Date.now();
      if (!state.handPending && now - state.handLastDet >= state.handDetInterval) {
        state.handPending = true; state.handLastDet = now;
        state.hands.send({ image: els.video }).then(() => {
          state.handPending = false;
        }).catch(err => { console.warn('hands send error', err); state.handPending = false; });
      }
    }

    // dibujar layout de teclado en la parte inferior
    const startY = h - 180;
    const rowH = 56;
    let highlightKey = null; let highlightRect = null;
    // obtener posición de índice y pinza
    let idxPt = null, pinch = false;
    if (state.handLandmarks) {
      const lm = state.handLandmarks;
      const ix = lm[8].x * w; const iy = lm[8].y * h;
      const tx = lm[4].x * w; const ty = lm[4].y * h;
      idxPt = { x: ix|0, y: iy|0 };
      const d = Math.hypot(lm[8].x - lm[4].x, lm[8].y - lm[4].y);
      pinch = d < 0.07; // umbral de pinza
    }

    for (let r = 0; r < state.kbdLayout.length; r++) {
      const keys = state.kbdLayout[r];
      const y1 = startY + r * rowH; const y2 = y1 + rowH - 4;
      const colW = Math.floor(w / keys.length);
      for (let c = 0; c < keys.length; c++) {
        const x1 = c * colW + 2; const x2 = (c+1) * colW - 2;
        const key = keys[c];
        const color = new cv.Scalar(80, 80, 80, 255);
        cv.rectangle(out, new cv.Point(x1, y1), new cv.Point(x2, y2), color, 2);
        cv.putText(out, key, new cv.Point(x1 + 8, y1 + 32), cv.FONT_HERSHEY_SIMPLEX, 0.7, new cv.Scalar(200,200,200,255), 1);
        if (idxPt && idxPt.x >= x1 && idxPt.x <= x2 && idxPt.y >= y1 && idxPt.y <= y2) {
          // resaltar tecla bajo el índice
          highlightKey = key; highlightRect = {x1,y1,x2,y2};
        }
      }
    }

    if (highlightRect) {
      cv.rectangle(out, new cv.Point(highlightRect.x1, highlightRect.y1), new cv.Point(highlightRect.x2, highlightRect.y2), new cv.Scalar(0, 180, 255, 255), 2);
    }
    if (idxPt) {
      cv.circle(out, new cv.Point(idxPt.x, idxPt.y), 6, new cv.Scalar(0,255,0,255), -1);
    }

    // registrar pulsación por pinza con cooldown
    if (pinch && highlightKey) {
      const now = Date.now();
      if (now - state.kbdLastPress > state.kbdPressCooldown) {
        state.kbdLastPress = now;
        if (highlightKey === 'ESP') state.kbdText += ' ';
        else if (highlightKey === 'BOR') state.kbdText = state.kbdText.slice(0, -1);
        else state.kbdText += highlightKey;
        if (els.kbdText) els.kbdText.value = state.kbdText;
      }
    }

    return out;
  }

  // OpenCV ready
  function onCvReady() {
    setCvStatus('listo');
    // Seed a blank frame to start
    const ctx = els.inCanvas.getContext('2d');
    ctx.fillStyle = '#111'; ctx.fillRect(0, 0, els.inCanvas.width, els.inCanvas.height);
    processFrame();
  }

  // Wait for cv
  const waitForCv = () => {
    if (window.cv && cv['onRuntimeInitialized'] !== undefined) {
      cv['onRuntimeInitialized'] = onCvReady;
      setCvStatus('inicializando...');
    } else {
      setCvStatus('cargando...');
      setTimeout(waitForCv, 200);
    }
  };
  waitForCv();
})();