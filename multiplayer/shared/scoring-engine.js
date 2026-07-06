// Copie exacte du moteur de score de index.html — voir le plan (plan file) : le score n'est jamais
// réécrit en SQL, uniquement en JS, pour ne maintenir les règles d'Azul qu'à un seul endroit logique
// (même si physiquement dupliqué entre les forks single-device et ce fichier multijoueur).
// Chargé via <script src="shared/scoring-engine.js"></script>, expose les mêmes noms en scope global.

const COLORS = [
  { id:'B', label:'Bleu',      hex:'#2563eb' },
  { id:'Y', label:'Jaune',     hex:'#eab308' },
  { id:'R', label:'Rouge',     hex:'#dc2626' },
  { id:'K', label:'Noir',      hex:'#27272a' },
  { id:'W', label:'Turquoise', hex:'#06b6d4' },
];
const COLOR_MAP = Object.fromEntries(COLORS.map(c => [c.id, c]));

// motif fixe du mur : chaque ligne est une rotation cyclique de la précédente
const WALL_PATTERN = [
  ['B','Y','R','K','W'],
  ['W','B','Y','R','K'],
  ['K','W','B','Y','R'],
  ['R','K','W','B','Y'],
  ['Y','R','K','W','B'],
];
const FLOOR_PENALTIES = [-1,-1,-2,-2,-2,-3,-3];

function createPlayer(name){
  return {
    name,
    wall: Array.from({length:5}, () => Array(5).fill(null)),
    patternLines: Array.from({length:5}, (_, i) => ({ capacity:i+1, color:null, count:0 })),
    floorFilled: 0,
    hasFirstPlayerMarker: false,
    totalScore: 0,
    roundHistory: [],
    finalBonuses: null,
  };
}

function wallColumnFor(row, color){ return WALL_PATTERN[row].indexOf(color); }

function runLength(wall, row, col, dRow, dCol){
  let r = row, c = col, count = 0;
  while (r >= 0 && r < 5 && c >= 0 && c < 5 && wall[r][c] !== null){
    count++; r += dRow; c += dCol;
  }
  return count;
}

function scoreTilePlacement(wall, row, col){
  const hRun = runLength(wall,row,col,0,1) + runLength(wall,row,col,0,-1) - 1;
  const vRun = runLength(wall,row,col,1,0) + runLength(wall,row,col,-1,0) - 1;
  if (hRun > 1 && vRun > 1) return hRun + vRun;
  if (hRun > 1) return hRun;
  if (vRun > 1) return vRun;
  return 1;
}

function sumFloorPenalty(filledCount){
  return FLOOR_PENALTIES.slice(0, filledCount).reduce((s,v) => s+v, 0);
}

function endRoundForPlayer(player, round){
  const completed = [];
  let wallScore = 0;
  player.patternLines.forEach((line, row) => {
    if (line.count === line.capacity && line.color !== null){
      const col = wallColumnFor(row, line.color);
      if (player.wall[row][col] !== null){
        line.color = null; line.count = 0;
        return;
      }
      player.wall[row][col] = line.color;
      const points = scoreTilePlacement(player.wall, row, col);
      wallScore += points;
      completed.push({ row, color:line.color, col, points });
      line.color = null; line.count = 0;
    }
  });
  const floorPenalty = sumFloorPenalty(player.floorFilled);
  player.floorFilled = 0;
  player.hasFirstPlayerMarker = false;
  const rawDelta = wallScore + floorPenalty;
  // le total cumulé ne peut jamais descendre sous 0 (règle officielle) ; on clampe le cumul, pas le delta de la manche
  const newTotal = Math.max(0, player.totalScore + rawDelta);
  player.roundHistory.push({ round, wallScore, floorPenalty, roundDelta:rawDelta, runningTotal:newTotal, completedLines:completed });
  player.totalScore = newTotal;
}

function computeEndGameBonuses(player){
  const wall = player.wall;
  let rows = 0, cols = 0, colors = 0;
  for (let r = 0; r < 5; r++) if (wall[r].every(c => c !== null)) rows++;
  for (let c = 0; c < 5; c++) if (wall.every(row => row[c] !== null)) cols++;
  for (const color of COLORS.map(c => c.id)){
    let count = 0;
    for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) if (wall[r][c] === color) count++;
    if (count === 5) colors++;
  }
  const bonusPoints = rows*2 + cols*7 + colors*10;
  player.finalBonuses = { rows, cols, colors, bonusPoints };
  player.totalScore += bonusPoints;
}
