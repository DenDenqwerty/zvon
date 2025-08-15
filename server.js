const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path'); // Добавляем модуль для работы с путями

const app = express();
app.use(cors());

// Добавляем middleware для обслуживания статических файлов
app.use(express.static(path.join(__dirname)));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Структуры данных
const rooms = new Map();       // roomId -> { users: Set, messages: [], createdAt }
const userRooms = new Map();   // userId -> Set(roomId)
const ROOM_EXPIRATION_MINUTES = 5;

// Генерация комнаты
function createRoom(roomId, userIds) {
  const room = {
    id: roomId,
    users: new Set(userIds),
    messages: [],
    createdAt: new Date(),
    timer: null
  };
  
  rooms.set(roomId, room);
  
  // Добавляем комнату пользователям
  userIds.forEach(userId => {
    if (!userRooms.has(userId)) {
      userRooms.set(userId, new Set());
    }
    userRooms.get(userId).add(roomId);
  });
  
  // Устанавливаем таймер удаления
  room.timer = setTimeout(() => {
    deleteRoom(roomId);
  }, ROOM_EXPIRATION_MINUTES * 60 * 1000);
  
  return room;
}

// Удаление комнаты
function deleteRoom(roomId) {
  if (!rooms.has(roomId)) return;
  
  const room = rooms.get(roomId);
  
  // Удаляем комнату у всех пользователей
  room.users.forEach(userId => {
    if (userRooms.has(userId)) {
      userRooms.get(userId).delete(roomId);
      if (userRooms.get(userId).size === 0) {
        userRooms.delete(userId);
      }
    }
  });
  
  // Очищаем таймер
  if (room.timer) clearTimeout(room.timer);
  
  rooms.delete(roomId);
  io.emit('room_deleted', roomId);
}

// Обновление таймера комнаты
function resetRoomTimer(roomId) {
  if (!rooms.has(roomId)) return;
  
  const room = rooms.get(roomId);
  if (room.timer) clearTimeout(room.timer);
  
  room.timer = setTimeout(() => {
    deleteRoom(roomId);
  }, ROOM_EXPIRATION_MINUTES * 60 * 1000);
}

// Socket.io соединения
io.on('connection', (socket) => {
  console.log('Новое подключение:', socket.id);
  
  // Регистрация пользователя
  socket.on('register', (userId) => {
    socket.userId = userId;
    sendUserRooms(userId);
  });
  
  // Создание комнаты
  socket.on('create_room', ({ roomId, userIds }) => {
    if (rooms.has(roomId)) {
      socket.emit('error', 'Комната с таким ID уже существует');
      return;
    }
    
    const room = createRoom(roomId, userIds);
    
    // Уведомляем всех участников
    userIds.forEach(userId => {
      io.to(userId).emit('room_created', {
        id: roomId,
        userCount: room.users.size
      });
    });
  });
  
  // Присоединение к комнате
  socket.on('join_room', ({ roomId, userId }) => {
    if (!rooms.has(roomId)) {
      socket.emit('error', 'Комната не найдена');
      return;
    }
    
    const room = rooms.get(roomId);
    if (!room.users.has(userId)) {
      room.users.add(userId);
      
      if (!userRooms.has(userId)) {
        userRooms.set(userId, new Set());
      }
      userRooms.get(userId).add(roomId);
    }
    
    socket.join(roomId);
    resetRoomTimer(roomId);
    
    // Отправляем информацию о комнате
    socket.emit('room_joined', {
      id: roomId,
      userCount: room.users.size
    });
    
    // Обновляем время удаления
    const minutesLeft = Math.ceil(
      (room.timer._idleStart + room.timer._idleTimeout - Date.now()) / 60000
    );
    socket.emit('room_expiration', minutesLeft);
    
    sendUserRooms(userId);
  });
  
  // Присоединение по ID пользователя
  socket.on('join_by_user', ({ userId, currentUserId }) => {
    // Поиск существующей комнаты для двоих
    let existingRoom = null;
    
    if (userRooms.has(currentUserId) && userRooms.has(userId)) {
      const userRoomsSet = new Set([
        ...userRooms.get(currentUserId),
        ...userRooms.get(userId)
      ]);
      
      for (const roomId of userRoomsSet) {
        const room = rooms.get(roomId);
        if (room && room.users.size === 2 && 
            room.users.has(currentUserId) && room.users.has(userId)) {
          existingRoom = room;
          break;
        }
      }
    }
    
    if (existingRoom) {
      socket.emit('room_joined', {
        id: existingRoom.id,
        userCount: existingRoom.users.size
      });
    } else {
      // Создаем новую комнату
      const roomId = generateRoomId();
      createRoom(roomId, [currentUserId, userId]);
      
      // Присоединяем пользователей
      socket.emit('room_created', {
        id: roomId,
        userCount: 2
      });
      
      io.to(userId).emit('room_created', {
        id: roomId,
        userCount: 2
      });
    }
  });
  
  // Отправка сообщения
  socket.on('send_message', ({ roomId, userId, message }) => {
    if (!rooms.has(roomId)) {
      socket.emit('error', 'Комната не найдена');
      return;
    }
    
    const room = rooms.get(roomId);
    if (!room.users.has(userId)) {
      socket.emit('error', 'Вы не участник комнаты');
      return;
    }
    
    // Сохраняем сообщение
    room.messages.push({
      userId,
      message,
      timestamp: new Date()
    });
    
    // Обновляем таймер комнаты
    resetRoomTimer(roomId);
    
    // Отправляем сообщение всем в комнате
    io.to(roomId).emit('new_message', {
      roomId,
      userId,
      message
    });
    
    // Обновляем время удаления для всех участников
    const minutesLeft = Math.ceil(
      (room.timer._idleStart + room.timer._idleTimeout - Date.now()) / 60000
    );
    io.to(roomId).emit('room_expiration', minutesLeft);
  });
  
  // Запрос истории сообщений
  socket.on('get_messages', (roomId) => {
    if (rooms.has(roomId)) {
      socket.emit('room_messages', rooms.get(roomId).messages);
    }
  });
  
  // Отправка списка комнат пользователя
  function sendUserRooms(userId) {
    if (userRooms.has(userId)) {
      const roomsData = Array.from(userRooms.get(userId)).map(roomId => {
        const room = rooms.get(roomId);
        return {
          id: roomId,
          userCount: room.users.size
        };
      });
      
      socket.emit('user_rooms', roomsData);
    } else {
      socket.emit('user_rooms', []);
    }
  }
  
  // Генерация ID комнаты
  function generateRoomId() {
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let result = '';
    
    for (let i = 0; i < 2; i++) {
      result += letters.charAt(Math.floor(Math.random() * letters.length));
    }
    
    for (let i = 0; i < 2; i++) {
      result += Math.floor(Math.random() * 10);
    }
    
    return result;
  }
});

// Добавляем обработчик для корневого пути
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});


const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});