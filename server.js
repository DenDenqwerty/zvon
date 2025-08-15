const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname)));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ['websocket', 'polling']
});

// Константы
const ROOM_EXPIRATION_MINUTES = 5; // 5 минут для теста

// Структуры данных
const rooms = new Map();
const userRooms = new Map();

// Функции работы с комнатами
function createRoom(roomId, userIds) {
  const expiresAt = Date.now() + ROOM_EXPIRATION_MINUTES * 60 * 1000;
  
  const room = {
    id: roomId,
    users: new Set(userIds),
    messages: [],
    createdAt: Date.now(),
    expiresAt: expiresAt,
    timer: setTimeout(() => deleteRoom(roomId), ROOM_EXPIRATION_MINUTES * 60 * 1000)
  };
  
  rooms.set(roomId, room);
  
  userIds.forEach(userId => {
    if (!userRooms.has(userId)) {
      userRooms.set(userId, new Set());
    }
    userRooms.get(userId).add(roomId);
  });
  
  return room;
}

function deleteRoom(roomId) {
  if (!rooms.has(roomId)) return;
  
  const room = rooms.get(roomId);
  
  // Уведомляем участников перед удалением
  io.to(roomId).emit('room_deleted', roomId);
  
  // Удаляем комнату у пользователей
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
}

function resetRoomTimer(roomId) {
  if (!rooms.has(roomId)) return;
  
  const room = rooms.get(roomId);
  if (room.timer) clearTimeout(room.timer);
  
  // Устанавливаем новое время удаления
  room.expiresAt = Date.now() + ROOM_EXPIRATION_MINUTES * 60 * 1000;
  
  room.timer = setTimeout(() => deleteRoom(roomId), ROOM_EXPIRATION_MINUTES * 60 * 1000);
}

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

// Socket.io обработчики
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
    
    // Добавляем пользователя в комнату
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
    
    // Отправляем текущее время до удаления
    const minutesLeft = Math.max(0, Math.ceil(
      (room.expiresAt - Date.now()) / 60000
    ));
    socket.emit('room_expiration', minutesLeft);
    
    // Обновляем список комнат пользователя
    sendUserRooms(userId);
  });
  
  // Присоединение по ID пользователя
  socket.on('join_by_user', ({ userId, currentUserId }) => {
    let existingRoom = null;
    
    // Поиск существующей комнаты для двоих
    if (userRooms.has(currentUserId) && userRooms.has(userId)) {
      const commonRooms = [...userRooms.get(currentUserId)].filter(
        roomId => userRooms.get(userId).has(roomId)
      );
      
      for (const roomId of commonRooms) {
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
      
      // Уведомляем обоих пользователей
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
    
    // Генерируем уникальный ID для сообщения
    const messageId = Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    
    // Сохраняем сообщение
    room.messages.push({
      id: messageId,
      userId,
      message,
      timestamp: new Date()
    });
    
    // Обновляем таймер комнаты
    resetRoomTimer(roomId);
    
    // Отправляем сообщение всем в комнате
    io.to(roomId).emit('new_message', {
      id: messageId,
      roomId,
      userId,
      message
    });
    
    // Обновляем время удаления для всех участников
    const minutesLeft = Math.max(0, Math.ceil(
      (room.expiresAt - Date.now()) / 60000
    ));
    io.to(roomId).emit('room_expiration', minutesLeft);
  });
  
  // Запрос истории сообщений
  socket.on('get_messages', (roomId) => {
    if (rooms.has(roomId)) {
      socket.emit('room_messages', {
        roomId,
        messages: rooms.get(roomId).messages
      });
    }
  });
  
  // Запрос времени до удаления комнаты
  socket.on('get_room_expiration', (roomId) => {
    if (rooms.has(roomId)) {
      const room = rooms.get(roomId);
      const minutesLeft = Math.max(0, Math.ceil(
        (room.expiresAt - Date.now()) / 60000
      ));
      socket.emit('room_expiration', minutesLeft);
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
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});