const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// Game state
const rooms = {};
const ROOM_TTL = 1000 * 60 * 60 * 2; // 2 hours

// Utility: generate room code
function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
}

// Weapon stats
const WEAPON_STATS = {
    pistol: { damage: 15, fireRate: 300, ammo: 12, reloadTime: 1000, spread: 0.02, range: 60 },
    shotgun: { damage: 8, fireRate: 800, ammo: 6, reloadTime: 2000, spread: 0.08, pellets: 8, range: 25 },
    rifle: { damage: 22, fireRate: 120, ammo: 30, reloadTime: 1800, spread: 0.015, range: 100 },
    sniper: { damage: 80, fireRate: 1500, ammo: 5, reloadTime: 2500, spread: 0.005, range: 150 }
};

io.on('connection', (socket) => {
    console.log('Player connected:', socket.id);
    let playerRoom = null;
    let playerName = '';

    // Create room
    socket.on('createRoom', (name, callback) => {
        playerName = name || 'Player';
        const code = generateRoomCode();
        rooms[code] = {
            code,
            host: socket.id,
            players: {},
            createdAt: Date.now(),
            gameStarted: false
        };
        joinRoom(code);
        callback({ success: true, code });
    });

    // Join room
    socket.on('joinRoom', (code, name, callback) => {
        playerName = name || 'Player';
        const room = rooms[code.toUpperCase()];
        if (!room) {
            callback({ success: false, error: 'Room not found' });
            return;
        }
        if (Object.keys(room.players).length >= 8) {
            callback({ success: false, error: 'Room is full' });
            return;
        }
        joinRoom(code.toUpperCase());
        callback({ success: true, code: code.toUpperCase() });
    });

    function joinRoom(code) {
        playerRoom = code;
        socket.join(code);
        const room = rooms[code];

        // Spawn position
        const spawnPoints = [
            { x: -20, z: -20 }, { x: 20, z: -20 },
            { x: -20, z: 20 }, { x: 20, z: 20 },
            { x: 0, z: -30 }, { x: 0, z: 30 },
            { x: -30, z: 0 }, { x: 30, z: 0 }
        ];
        const spawn = spawnPoints[Object.keys(room.players).length % spawnPoints.length];

        room.players[socket.id] = {
            id: socket.id,
            name: playerName,
            x: spawn.x, y: 1.6, z: spawn.z,
            rx: 0, ry: 0,
            health: 100,
            weapon: 'pistol',
            ammo: WEAPON_STATS.pistol.ammo,
            maxAmmo: WEAPON_STATS.pistol.ammo,
            isReloading: false,
            isAiming: false,
            kills: 0,
            deaths: 0,
            color: `hsl(${Math.random() * 360}, 70%, 60%)`
        };

        // Send existing players to new player
        socket.emit('roomJoined', {
            code,
            players: room.players,
            you: socket.id
        });

        // Notify others
        socket.to(code).emit('playerJoined', room.players[socket.id]);
    }

    // Player movement update
    socket.on('playerMove', (data) => {
        if (!playerRoom || !rooms[playerRoom]) return;
        const player = rooms[playerRoom].players[socket.id];
        if (!player) return;

        player.x = data.x;
        player.y = data.y;
        player.z = data.z;
        player.rx = data.rx;
        player.ry = data.ry;

        socket.to(playerRoom).emit('playerMoved', {
            id: socket.id,
            x: data.x, y: data.y, z: data.z,
            rx: data.rx, ry: data.ry
        });
    });

    // Weapon switch
    socket.on('switchWeapon', (weapon) => {
        if (!playerRoom || !rooms[playerRoom]) return;
        const player = rooms[playerRoom].players[socket.id];
        if (!player || !WEAPON_STATS[weapon]) return;

        player.weapon = weapon;
        player.ammo = WEAPON_STATS[weapon].ammo;
        player.maxAmmo = WEAPON_STATS[weapon].ammo;
        player.isReloading = false;

        io.to(playerRoom).emit('playerSwitchedWeapon', {
            id: socket.id,
            weapon: weapon
        });
    });

    // Toggle aim
    socket.on('toggleAim', (aiming) => {
        if (!playerRoom || !rooms[playerRoom]) return;
        const player = rooms[playerRoom].players[socket.id];
        if (!player) return;
        player.isAiming = aiming;
        socket.to(playerRoom).emit('playerAimToggled', { id: socket.id, aiming });
    });

    // Reload
    socket.on('reload', () => {
        if (!playerRoom || !rooms[playerRoom]) return;
        const player = rooms[playerRoom].players[socket.id];
        if (!player || player.isReloading || player.ammo >= player.maxAmmo) return;

        const stats = WEAPON_STATS[player.weapon];
        player.isReloading = true;

        io.to(playerRoom).emit('playerReloading', { id: socket.id });

        setTimeout(() => {
            if (!rooms[playerRoom] || !rooms[playerRoom].players[socket.id]) return;
            rooms[playerRoom].players[socket.id].ammo = stats.ammo;
            rooms[playerRoom].players[socket.id].isReloading = false;
            io.to(playerRoom).emit('playerReloaded', { id: socket.id, ammo: stats.ammo });
        }, stats.reloadTime);
    });

    // Shoot
    socket.on('shoot', (data) => {
        if (!playerRoom || !rooms[playerRoom]) return;
        const room = rooms[playerRoom];
        const shooter = room.players[socket.id];
        if (!shooter || shooter.isReloading || shooter.ammo <= 0) return;

        const stats = WEAPON_STATS[shooter.weapon];
        shooter.ammo--;

        // Hit detection
        const hits = [];
        const origin = { x: data.x, y: data.y, z: data.z };
        const dir = { x: data.dx, y: data.dy, z: data.dz };

        // Normalize direction
        const len = Math.sqrt(dir.x*dir.x + dir.y*dir.y + dir.z*dir.z);
        dir.x /= len; dir.y /= len; dir.z /= len;

        for (const [pid, target] of Object.entries(room.players)) {
            if (pid === socket.id || target.health <= 0) continue;

            const hit = raycastHit(origin, dir, target, stats);
            if (hit) {
                let damage = stats.damage;
                if (shooter.weapon === 'shotgun') damage = stats.damage * (hit.distance < 10 ? 1.5 : hit.distance < 20 ? 1 : 0.5);
                if (shooter.isAiming && shooter.weapon === 'sniper') damage *= 1.5;

                target.health = Math.max(0, target.health - Math.round(damage));
                hits.push({ id: pid, damage: Math.round(damage), health: target.health });

                if (target.health <= 0) {
                    shooter.kills++;
                    target.deaths++;
                    io.to(playerRoom).emit('playerKilled', {
                        killer: socket.id,
                        victim: pid,
                        killerName: shooter.name,
                        victimName: target.name
                    });

                    // Respawn after 3 seconds
                    setTimeout(() => {
                        if (!room.players[pid]) return;
                        const spawns = [
                            { x: -20, z: -20 }, { x: 20, z: -20 },
                            { x: -20, z: 20 }, { x: 20, z: 20 }
                        ];
                        const s = spawns[Math.floor(Math.random() * spawns.length)];
                        room.players[pid].x = s.x;
                        room.players[pid].y = 1.6;
                        room.players[pid].z = s.z;
                        room.players[pid].health = 100;
                        room.players[pid].ammo = WEAPON_STATS[room.players[pid].weapon].ammo;
                        io.to(playerRoom).emit('playerRespawned', {
                            id: pid,
                            x: s.x, y: 1.6, z: s.z,
                            health: 100,
                            ammo: room.players[pid].ammo
                        });
                    }, 3000);
                }
            }
        }

        io.to(playerRoom).emit('playerShot', {
            id: socket.id,
            origin,
            direction: dir,
            weapon: shooter.weapon,
            ammo: shooter.ammo,
            hits
        });
    });

    // Chat
    socket.on('chat', (msg) => {
        if (!playerRoom || !rooms[playerRoom]) return;
        const player = rooms[playerRoom].players[socket.id];
        if (!player) return;
        io.to(playerRoom).emit('chatMessage', {
            name: player.name,
            msg: msg.substring(0, 100)
        });
    });

    // Disconnect
    socket.on('disconnect', () => {
        console.log('Player disconnected:', socket.id);
        if (playerRoom && rooms[playerRoom]) {
            delete rooms[playerRoom].players[socket.id];
            socket.to(playerRoom).emit('playerLeft', socket.id);

            if (Object.keys(rooms[playerRoom].players).length === 0) {
                setTimeout(() => {
                    if (rooms[playerRoom] && Object.keys(rooms[playerRoom].players).length === 0) {
                        delete rooms[playerRoom];
                    }
                }, 60000);
            }
        }
    });
});

// Simple ray-sphere hit detection for player hitboxes
function raycastHit(origin, dir, target, stats) {
    const playerPos = { x: target.x, y: target.y - 0.3, z: target.z };
    const radius = 0.6;
    const height = 1.6;

    // Check distance first (optimization)
    const dx = playerPos.x - origin.x;
    const dy = playerPos.y - origin.y;
    const dz = playerPos.z - origin.z;
    const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
    if (dist > stats.range) return null;

    // Ray-sphere intersection (simplified as cylinder)
    const oc = { x: origin.x - playerPos.x, y: origin.y - playerPos.y, z: origin.z - playerPos.z };
    const a = dir.x*dir.x + dir.z*dir.z;
    const b = 2 * (oc.x*dir.x + oc.z*dir.z);
    const c = oc.x*oc.x + oc.z*oc.z - radius*radius;
    const disc = b*b - 4*a*c;

    if (disc < 0) return null;

    const t = (-b - Math.sqrt(disc)) / (2*a);
    const hitY = origin.y + t * dir.y;

    if (hitY >= playerPos.y - height/2 && hitY <= playerPos.y + height/2) {
        return { distance: dist };
    }
    return null;
}

// Cleanup old rooms
setInterval(() => {
    const now = Date.now();
    for (const [code, room] of Object.entries(rooms)) {
        if (now - room.createdAt > ROOM_TTL && Object.keys(room.players).length === 0) {
            delete rooms[code];
        }
    }
}, 60000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`FPS Server running on port ${PORT}`);
});
