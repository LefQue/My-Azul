// Copie du pipeline de scan CNN de version_ia/index-scan-cnn.html (géométrie/homographie + inférence
// CNN), sans le code HSV classique devenu mort dans ce fichier (classifySample/scanColorDistance/etc,
// jamais appelés par le chemin CNN). Nécessite que tf.min.js soit chargé avant ce fichier.
// Chargé via <script src="shared/scan-pipeline.js"></script>.

function realCellsForRow(row){
  const cells = [];
  for (let c = 4 - row; c <= 4; c++) cells.push(c);
  return cells;
}

// -- homographie : résout H tel que canonique(0..5,0..5) -> photo, à partir de 4 correspondances --
function solveLinearSystem(A, b){
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++){
    let pivot = col;
    for (let r = col + 1; r < n; r++){
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    [M[col], M[pivot]] = [M[pivot], M[col]];
    const div = M[col][col];
    for (let c = col; c <= n; c++) M[col][c] /= div;
    for (let r = 0; r < n; r++){
      if (r === col) continue;
      const factor = M[r][col];
      for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
    }
  }
  return M.map(row => row[n]);
}

function solveHomography(canonicalPts, photoPts){
  const A = [], b = [];
  for (let i = 0; i < 4; i++){
    const { x: xc, y: yc } = canonicalPts[i];
    const { x: xp, y: yp } = photoPts[i];
    A.push([xc, yc, 1, 0, 0, 0, -xp * xc, -xp * yc]); b.push(xp);
    A.push([0, 0, 0, xc, yc, 1, -yp * xc, -yp * yc]); b.push(yp);
  }
  const h = solveLinearSystem(A, b);
  return { h11:h[0], h12:h[1], h13:h[2], h21:h[3], h22:h[4], h23:h[5], h31:h[6], h32:h[7] };
}

function applyHomography(H, xc, yc){
  const denom = H.h31 * xc + H.h32 * yc + 1;
  return {
    x: (H.h11 * xc + H.h12 * yc + H.h13) / denom,
    y: (H.h21 * xc + H.h22 * yc + H.h23) / denom,
  };
}

function getPixel(imageData, x, y){
  const px = Math.max(0, Math.min(imageData.width - 1, Math.round(x)));
  const py = Math.max(0, Math.min(imageData.height - 1, Math.round(y)));
  const idx = (py * imageData.width + px) * 4;
  return { r: imageData.data[idx], g: imageData.data[idx+1], b: imageData.data[idx+2] };
}

// -- extraction d'image de case pour le CNN : PATCH_SIZE/PATCH_MARGIN doivent matcher train_model.py --
const PATCH_SIZE = 48;
const PATCH_MARGIN = 0.12;
const SCAN_CANONICAL_PTS = [{x:0,y:0},{x:5,y:0},{x:5,y:5},{x:0,y:5}];
const SCAN_MAX_DIM = 1400;

function extractCellPatch(imageData, H, row, col, size){
  size = size || PATCH_SIZE;
  const out = new ImageData(size, size);
  for (let j = 0; j < size; j++){
    for (let i = 0; i < size; i++){
      const u = (i + 0.5) / size, v = (j + 0.5) / size;
      const xc = col + PATCH_MARGIN + u * (1 - 2*PATCH_MARGIN);
      const yc = row + PATCH_MARGIN + v * (1 - 2*PATCH_MARGIN);
      const p = applyHomography(H, xc, yc);
      const px = getPixel(imageData, p.x, p.y);
      const idx = (j*size + i) * 4;
      out.data[idx] = px.r; out.data[idx+1] = px.g; out.data[idx+2] = px.b; out.data[idx+3] = 255;
    }
  }
  return out;
}

function patchToCanvas(patchImageData){
  const c = document.createElement('canvas');
  c.width = patchImageData.width; c.height = patchImageData.height;
  c.getContext('2d').putImageData(patchImageData, 0, 0);
  return c;
}

// ATTENTION : cet ordre doit être recopié EXACTEMENT depuis la sortie de train_model.py
// (Keras trie les classes alphabétiquement : B,K,R,W,Y,empty -- pas B,Y,R,K,W,empty)
const CNN_LABELS = ['B','K','R','W','Y','empty'];
const CNN_CONFIDENCE_THRESHOLD = 0.6;
let cnnModel = null;
let cnnModelError = null;

// onStatusChange(state, detail) : state = 'loading' | 'ready' | 'error' — chaque page définit son
// propre affichage (badge, toast, etc.), ce fichier ne suppose aucune structure DOM particulière.
async function loadCnnModel(modelUrlPath, onStatusChange){
  const notify = onStatusChange || function(){};
  notify('loading');
  const modelUrl = new URL(modelUrlPath || 'tfjs_model/model.json', window.location.href).href;
  try{
    cnnModel = await tf.loadLayersModel(modelUrl);
    tf.tidy(() => cnnModel.predict(tf.zeros([1, PATCH_SIZE, PATCH_SIZE, 3])));
    cnnModelError = null;
    notify('ready');
    console.log('Modèle CNN chargé depuis', modelUrl);
  }catch(e){
    cnnModel = null;
    cnnModelError = e;
    notify('error', `${modelUrl} — ${e && e.message ? e.message : e}`);
    console.warn('Modèle CNN introuvable/invalide.', modelUrl, e);
  }
}

// classe les 15 cases réelles en un seul batch, renvoie {kind, ambiguous} par case
function classifyCellsCnn(imageData, H, cellDescriptors){
  const patches = cellDescriptors.map(({row,col}) =>
    tf.browser.fromPixels(patchToCanvas(extractCellPatch(imageData, H, row, col))).toFloat()
  );
  const batch = tf.stack(patches);
  const probsTensor = cnnModel.predict(batch);
  const probs = probsTensor.arraySync();
  tf.dispose([...patches, batch, probsTensor]);

  return probs.map(p => {
    const sorted = p.map((v,i) => ({ v, i })).sort((a,b) => b.v - a.v);
    const [best, second] = sorted;
    let ambiguous = best.v < CNN_CONFIDENCE_THRESHOLD;
    // cas connu le plus dur : turquoise/blanc vs vide se ressemblent visuellement sur cette édition de
    // tuiles — ne jamais trancher silencieusement si ce sont les deux meilleures classes et qu'elles sont proches
    const pair = new Set([CNN_LABELS[best.i], CNN_LABELS[second.i]]);
    if (pair.has('W') && pair.has('empty') && (best.v - second.v) < 0.25) ambiguous = true;
    const kind = CNN_LABELS[best.i] === 'empty' ? null : CNN_LABELS[best.i];
    return { kind, ambiguous };
  });
}

// -- agrégation par ligne : depuis le côté mur, la 1ère case vide arrête le comptage --
function aggregateScanRow(cellResults){
  const fromWall = [...cellResults].reverse();
  let count = 0, color = null, anomaly = false;
  for (const cell of fromWall){
    if (cell.kind === null) break;
    if (color === null) color = cell.kind;
    else if (cell.kind !== color) anomaly = true;
    count++;
  }
  for (let i = count; i < fromWall.length; i++){
    if (fromWall[i].kind !== null) anomaly = true;
  }
  if (cellResults.some(c => c.ambiguous)) anomaly = true;
  return { color, count, anomaly };
}

// classification par CNN : un seul batch pour les 15 cases réelles, puis agrégation par ligne
function runScanPipeline(imageData, H){
  const descriptors = [];
  for (let row = 0; row < 5; row++){
    for (const col of realCellsForRow(row)) descriptors.push({ row, col });
  }
  const cellResults = classifyCellsCnn(imageData, H, descriptors);

  const rows = [];
  let idx = 0;
  for (let row = 0; row < 5; row++){
    const capacity = row + 1;
    rows.push(aggregateScanRow(cellResults.slice(idx, idx + capacity)));
    idx += capacity;
  }
  return rows;
}

// ================================================================
// -- détection automatique de la ligne de plancher (7 cases, occupé/vide) --
// Même CNN que les lignes de motifs : chaque case est classée B/K/R/W/Y/empty et seule la
// distinction vide/occupé est utilisée (une tuile en trop compte pareil quelle que soit sa
// couleur). Remplace l'ancien seuillage de distance RGB, trop sensible à l'éclairage et à la
// couleur du fond de plateau, qui demandait une calibration manuelle.
// ================================================================

// carré canonique dédié : 7 cases sur 1 seule ligne, calibré séparément du triangle des lignes
// de motifs (mais généralement sur la MÊME photo, recadrée par 4 repères)
const FLOOR_CANONICAL_PTS = [{x:0,y:0},{x:7,y:0},{x:7,y:1},{x:0,y:1}];

// compte les cases occupées en partant de la gauche (remplissage physique réel) ; une case occupée
// après un "trou" (case vide suivie d'une case occupée) est une anomalie signalée, pas bloquante.
// Nécessite cnnModel chargé (comme runScanPipeline).
function runFloorScanPipeline(imageData, H){
  const descriptors = Array.from({length:7}, (_, col) => ({ row: 0, col }));
  const cellResults = classifyCellsCnn(imageData, H, descriptors);
  let count = 0;
  for (const r of cellResults){ if (r.kind === null) break; count++; }
  const anomaly = cellResults.slice(count).some(r => r.kind !== null)
    || cellResults.some(r => r.ambiguous);
  return { count, anomaly, cellResults };
}
