import {MAP_CELL} from "./config.js";

const EPSILON = 1e-6;

// Tuning
const CELLS_PER_PLAYER = 75 //65;
const MIN_CELLS = 150;
const ASPECT = 1.5;            // width : height
const CHUNK = 6;               // chunk size in cells (only used to spread obstacles out)
const GAP = 1;                 // min free cells between any two obstacles / the border

// Obstacle shapes as [col, row] cells. Must not contain holes
const SHAPES = [
    [[0, 0]],                                         // 1x1
    [[0, 0], [1, 0]],                                 // 1x2
    [[0, 0], [1, 0], [2, 0]],                         // 1x3
    [[0, 0], [1, 0], [2, 0], [3, 0]],                 // 1x4
    [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]],         // 1x5
    [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0]], // 1x6
    [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0], [6, 0]], // 1x7
    [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0], [6, 0], [7, 0]], // 1x8

    [[0, 0], [1, 0], [0, 1], [1, 1]],                    // 2x2
    [[0, 0], [1, 0], [2, 0], [0, 1], [2, 1]],           // 2x3 C

    [[0, 0], [0, 1], [1, 1], [2, 1]],                   // 2x2 L
    [[0, 0], [0, 1], [0, 2], [1, 2], [2, 2]],           // 2x3 L

    [[0, 0], [1, 0], [2, 0], [1, 1]],                   // 2x2 T
    [[0, 0], [1, 0], [2, 0], [1, 1], [1, 2]],           // 2x3 T

    [[0, 0], [1, 0], [1, 1], [2, 1], [2, 2]],           // 2x3 zigzag
    [[1, 0], [0, 1], [1, 1], [2, 1], [1, 2]],           // plus
];

export function mulberry32(seed) {
    let state = seed;
    return function () {
        state |= 0;
        state = (state + 0x6D2B79F5) | 0;
        let value = Math.imul(state ^ (state >>> 15), 1 | state);
        value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

/** World size in pixels for a given player count. */
export function getWorldSize(playerCount) {
    const area = Math.max(MIN_CELLS, playerCount * CELLS_PER_PLAYER);
    const cols = Math.round(Math.sqrt(area * ASPECT));
    const rows = Math.round(area / cols);
    return {cols, rows};
}

function transform(shape, rot, mirror) {
    let cells = shape.map(([c, r]) => [mirror ? -c : c, r]);
    for (let i = 0; i < rot; i++) cells = cells.map(([c, r]) => [-r, c]);
    const minC = Math.min(...cells.map((p) => p[0]));
    const minR = Math.min(...cells.map((p) => p[1]));
    return cells.map(([c, r]) => [c - minC, r - minR]);
}

function shuffle(arr, rng) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function canPlace(solid, cols, rows, cells, ox, oy) {
    for (const [dc, dr] of cells) {
        const c = ox + dc;
        const r = oy + dr;
        // Stay GAP cells away from the border
        if (c < GAP || r < GAP || c >= cols - GAP || r >= rows - GAP) return false;
        // Stay GAP cells away from every other obstacle
        for (let rr = r - GAP; rr <= r + GAP; rr++) {
            for (let cc = c - GAP; cc <= c + GAP; cc++) {
                if (solid[rr * cols + cc]) return false;
            }
        }
    }
    return true;
}

/**
 * Keep only the largest connected free region; everything else becomes solid.
 * Obstacles are already spaced so this should be a no-op, but it is a hard
 * guarantee that nobody can spawn in a sealed-off pocket.
 */
function sealDisconnected(solid, cols, rows) {
    const region = new Int32Array(cols * rows).fill(-1);
    const sizes = [];
    const stack = [];

    for (let start = 0; start < solid.length; start++) {
        if (solid[start] || region[start] !== -1) continue;
        const id = sizes.length;
        let size = 0;
        region[start] = id;
        stack.push(start);
        while (stack.length) {
            const i = stack.pop();
            size++;
            const c = i % cols;
            const r = (i / cols) | 0;
            const next = [
                c > 0 ? i - 1 : -1,
                c < cols - 1 ? i + 1 : -1,
                r > 0 ? i - cols : -1,
                r < rows - 1 ? i + cols : -1,
            ];
            for (const n of next) {
                if (n >= 0 && !solid[n] && region[n] === -1) {
                    region[n] = id;
                    stack.push(n);
                }
            }
        }
        sizes.push(size);
    }

    if (sizes.length <= 1) return;
    const best = sizes.indexOf(Math.max(...sizes));
    for (let i = 0; i < solid.length; i++) {
        if (!solid[i] && region[i] !== best) solid[i] = 1;
    }
}

/**
 * Pass a seeded rng (e.g. mulberry32) if every client must build the same map.
 */
export function createMap(cols, rows, rng = Math.random) {
    const solid = new Uint8Array(cols * rows);

    // Visit chunks in random order, but place shapes at jittered positions
    // (not snapped to chunk edges) with random rotation/mirroring, so the
    // result doesn't read as a grid.
    const chunks = [];
    for (let cy = 0; cy < rows; cy += CHUNK) {
        for (let cx = 0; cx < cols; cx += CHUNK) chunks.push([cx, cy]);
    }
    shuffle(chunks, rng);

    for (const [cx, cy] of chunks) {
        const wanted = rng() < 0.5 ? 3 : 2; // most chunks get 2 obstacles, some 3
        let placed = 0;
        for (let attempt = 0; attempt < 20 && placed < wanted; attempt++) {
            const shape = SHAPES[Math.floor(rng() * SHAPES.length)];
            const cells = transform(shape, Math.floor(rng() * 4), rng() < 0.5);
            const ox = cx - 1 + Math.floor(rng() * (CHUNK + 2));
            const oy = cy - 1 + Math.floor(rng() * (CHUNK + 2));
            if (!canPlace(solid, cols, rows, cells, ox, oy)) continue;
            for (const [dc, dr] of cells) solid[(oy + dr) * cols + (ox + dc)] = 1;
            placed++;
        }
    }

    sealDisconnected(solid, cols, rows);

    return {cell: MAP_CELL, cols, rows, solid};
}

export function buildWorld(cols, rows, rng = Math.random) {
    return {
        W: cols * MAP_CELL,
        H: rows * MAP_CELL,
        map: createMap(cols, rows, rng),
    };
}

export function isSolid(map, col, row) {
    if (col < 0 || row < 0 || col >= map.cols || row >= map.rows) return true;
    return map.solid[row * map.cols + col] === 1;
}

export function isAreaFree(map, x, y, half) {
    const minCol = Math.floor((x - half) / map.cell + EPSILON);
    const maxCol = Math.floor((x + half) / map.cell - EPSILON);
    const minRow = Math.floor((y - half) / map.cell + EPSILON);
    const maxRow = Math.floor((y + half) / map.cell - EPSILON);

    for (let row = minRow; row <= maxRow; row++) {
        for (let col = minCol; col <= maxCol; col++) {
            if (isSolid(map, col, row)) return false;
        }
    }

    return true;
}

export const TRAIL_S = 2;

export function recordTrails(trails, game, now) {
    const {cell, cols} = game.world.map;
    for (const player of game.players.values()) {
        if (player.status !== 0 || player.id === game.localId) continue;
        const col = Math.floor(player.x / cell);
        const row = Math.floor(player.y / cell);
        if (col >= 0 && row >= 0 && col < game.world.map.cols && row < game.world.map.rows) {
            trails.set(row * cols + col, now);
        }
    }
    for (const [index, at] of trails) {
        if (now - at > TRAIL_S * 1000) trails.delete(index);
    }
}

export function trailStrength(trails, map, x, y, now) {
    const col = Math.floor(x / map.cell);
    const row = Math.floor(y / map.cell);
    if (col < 0 || row < 0 || col >= map.cols || row >= map.rows) return 0;
    const at = trails.get(row * map.cols + col);
    return at === undefined ? 0 : Math.max(0, 1 - (now - at) / (TRAIL_S * 1000));
}

export function* trailTiles(trails, map, now) {
    for (const [index, at] of trails) {
        const strength = Math.max(0, 1 - (now - at) / (TRAIL_S * 1000));
        if (strength > 0) {
            yield {col: index % map.cols, row: Math.floor(index / map.cols), strength};
        }
    }
}

export function randomFreePosition(world, clearance) {
    const {W, H, map} = world;

    while (true) {
        const x = clearance + Math.random() * (W - clearance * 2);
        const y = clearance + Math.random() * (H - clearance * 2);
        if (isAreaFree(map, x, y, clearance)) return {x, y};
    }
}
