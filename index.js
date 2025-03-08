// File: server/src/index.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const geoip = require('geoip-lite');
const requestIp = require('request-ip');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    accessControlAllowOrigin: '*',
    credentials: true,
  },
});

app.use(cors());
app.use(express.json());
app.use(requestIp.mw());

// Game state
let players = [];
let grid = Array(100)
  .fill(null)
  .map((_, i) => ({
    id: i,
    color: '#FFFFFF',
    ownerId: '',
    ownerName: '',
  }));
let timeLeft = 60;
let gameInterval = null;
let winner = null;
let countdown = null;
let adminId = null;

// Game setup - first block always black (admin)
grid[0] = {
  id: 0,
  color: '#000000',
  ownerId: 'admin',
  ownerName: 'Admin',
};

// Function to generate a random HSL color
function generateRandomColor() {
  const hue = Math.floor(Math.random() * 360);
  const saturation = Math.floor(Math.random() * 100);
  const lightness = Math.floor(Math.random() * 60);
  return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}

// Get country information from IP address
function getCountryFromIP(socket) {
  const forwardedFor = socket.handshake.headers['x-forwarded-for'];
  const clientIP = forwardedFor
    ? forwardedFor.split(',')[0].trim()
    : socket.conn.remoteAddress;

  let cleanIP = clientIP;
  if (cleanIP === '::1') {
    cleanIP = '127.0.0.1';
  }
  cleanIP = cleanIP.replace(/^::ffff:/, '');

  const geo = geoip.lookup(cleanIP);

  return {
    code: geo?.country || 'xx',
    name: geo?.country || 'Unknown',
  };
}

// Initialize the game timer
function startGameTimer() {
  clearInterval(gameInterval);
  timeLeft = 60;
  winner = null;
  countdown = null;

  // Reset player scores and assign colors
  players.forEach((player) => {
    player.score = player.id === adminId ? 1 : 0;
  });

  // Reset grid except for admin square
  grid = grid.map((square, index) => {
    if (index === 0) {
      return {
        id: 0,
        color: '#000000',
        ownerId: adminId || 'admin',
        ownerName: adminId
          ? players.find((p) => p.id === adminId)?.name || 'Admin'
          : 'Admin',
      };
    }
    return {
      id: index,
      color: '#FFFFFF',
      ownerId: '',
      ownerName: '',
    };
  });

  // Broadcast game state
  broadcastGameState();

  gameInterval = setInterval(() => {
    timeLeft--;

    if (timeLeft <= 0) {
      endGame();
    } else {
      broadcastGameState();
    }
  }, 1000);
}

// End game and determine winner
function endGame() {
  clearInterval(gameInterval);

  const scores = {};
  players.forEach((player) => {
    scores[player.id] = 0;
  });

  grid.forEach((square) => {
    if (square.ownerId) {
      scores[square.ownerId] = (scores[square.ownerId] || 0) + 1;
    }
  });

  players.forEach((player) => {
    player.score = scores[player.id] || 0;
  });

  let maxScore = 0;
  let winningPlayer = null;

  players.forEach((player) => {
    if (player.score > maxScore) {
      maxScore = player.score;
      winningPlayer = player;
    }
  });

  winner = winningPlayer;

  if (!winningPlayer && adminId) {
    winner = players.find((p) => p.id === adminId);
  } else if (!winningPlayer) {
    winner = {
      id: 'admin',
      name: 'Admin',
      color: '#000000',
      score: 1,
    };
  }

  broadcastGameState();

  countdown = 10;
  const countdownInterval = setInterval(() => {
    countdown--;
    broadcastGameState();

    if (countdown <= 0) {
      clearInterval(countdownInterval);
      startGameTimer();
    }
  }, 1000);
}

// Broadcast current game state to all connected clients
function broadcastGameState() {
  io.emit('gameState', {
    grid,
    players,
    timeLeft,
    countdown,
    winner,
  });
}

function calculateScores() {
  const scores = {};

  grid.forEach((square) => {
    if (square.ownerId) {
      scores[square.ownerId] = (scores[square.ownerId] || 0) + 1;
    }
  });

  players.forEach((player) => {
    player.score = scores[player.id] || 0;
  });
}

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  const country = getCountryFromIP(socket);
  console.log(
    `Client from ${socket.handshake.address} → Country: ${country.name}`
  );

  if (players.length === 0 && !adminId) {
    adminId = socket.id;
    socket.emit('adminStatus', true);
  } else {
    socket.emit('adminStatus', false);
  }

  socket.emit('gameState', {
    grid,
    players,
    timeLeft,
    countdown,
    winner,
  });

  // Handle player joining
  socket.on('joinGame', (data, callback) => {
    const existingPlayer = players.find((player) => player.name === data.name);
    if (existingPlayer) {
      // Name already taken, send error message
      callback({
        success: false,
        message: 'This name is already taken. Please choose a different one.',
      });
      return;
    }

    const newPlayer = {
      id: socket.id,
      name: data.name.substring(0, 15), // Limit name to 15 characters
      color: data.color, // Use the color provided by the client
      score: 0,
      country,
    };

    if (socket.id === adminId) {
      newPlayer.color = '#000000';
      newPlayer.score = 1; // Admin starts with first square
    } else {
      if (newPlayer.color === '#000000') {
        // Non-admin player cannot have black color
        newPlayer.color = generateRandomColor();
        while (players.some((p) => p.color === newPlayer.color)) {
          newPlayer.color = generateRandomColor();
        }
      }
    }

    players.push(newPlayer);

    // Start game if it's not already running
    if (!gameInterval) {
      startGameTimer();
    }

    calculateScores();
    broadcastGameState();

    // Send success callback
    callback({ success: true });
  });

  socket.on('claimSquare', (squareId) => {
    if (countdown !== null || winner !== null) return;

    const player = players.find((p) => p.id === socket.id);
    if (!player) return;

    // Admin cannot claim any square except the first one
    if (squareId === 0 && socket.id !== adminId) return;

    // Update grid
    grid[squareId] = {
      id: squareId,
      color: player.color,
      ownerId: player.id,
      ownerName: player.name,
    };

    calculateScores();
    broadcastGameState();
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);

    players = players.filter((player) => player.id !== socket.id);

    if (socket.id === adminId) {
      adminId = players.length > 0 ? players[0].id : null;

      if (adminId) {
        const adminPlayer = players.find((p) => p.id === adminId);
        if (adminPlayer) {
          adminPlayer.color = '#000000';

          grid[0] = {
            id: 0,
            color: '#000000',
            ownerId: adminId,
            ownerName: adminPlayer.name,
          };

          io.to(adminId).emit('adminStatus', true);
        }
      }
    }

    if (players.length === 0) {
      clearInterval(gameInterval);
      gameInterval = null;
      timeLeft = 60;
      winner = null;
      countdown = null;

      grid = grid.map((_, index) => {
        if (index === 0) {
          return {
            id: 0,
            color: '#000000',
            ownerId: 'admin',
            ownerName: 'Admin',
          };
        }
        return {
          id: index,
          color: '#FFFFFF',
          ownerId: '',
          ownerName: '',
        };
      });
    } else {
      calculateScores();
    }

    broadcastGameState();
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
