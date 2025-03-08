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

// Admin always exists
const adminPlayer = {
  id: 'admin', // Static admin ID
  name: 'Admin',
  color: '#000000',
  score: 1, // Admin starts with the first square
  isAdmin: true,
};

// Admin owns the first square
grid[0] = {
  id: 0,
  color: '#000000',
  ownerId: 'admin',
  ownerName: 'Admin',
};

// Add admin to the players list
players.push(adminPlayer);

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

  // Reset player scores (except admin)
  players.forEach((player) => {
    if (!player.isAdmin) {
      player.score = 0;
    }
  });

  // Reset grid (except admin square)
  grid = grid.map((square, index) => {
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

// Calculate player scores
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

  // Emit initial game state
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
      callback({
        success: false,
        message: 'This name is already taken. Please choose a different one.',
      });
      return;
    }

    // Prevent players from joining as admin
    if (data.name.toLowerCase() === 'admin') {
      callback({
        success: false,
        message:
          'You cannot use the name "Admin". Please choose a different name.',
      });
      return;
    }

    const newPlayer = {
      id: socket.id,
      name: data.name.substring(0, 15), // Limit name to 15 characters
      color: data.color,
      score: 0,
      country,
      isAdmin: false, // Regular players are not admin
    };

    players.push(newPlayer);

    // Start game if it's not already running
    if (!gameInterval) {
      startGameTimer();
    }

    calculateScores();
    broadcastGameState();

    callback({ success: true });
  });

  // Handle square claiming
  socket.on('claimSquare', (squareId) => {
    if (countdown !== null || winner !== null || squareId === 0) return; // Prevent claiming the admin square

    const player = players.find((p) => p.id === socket.id);
    if (!player) return;

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

  // Handle player disconnection
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);

    players = players.filter((player) => player.id !== socket.id);

    if (players.length === 0) {
      clearInterval(gameInterval);
      gameInterval = null;
      timeLeft = 60;
      winner = null;
      countdown = null;

      // Reset grid (except admin square)
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
