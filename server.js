const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' })); // 画像送信に対応するため上限設定

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

// Supabase初期化（Renderの環境変数が設定されていれば有効化）
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = (SUPABASE_URL && SUPABASE_KEY) ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

// メモリ内データ保持（高速読み出し用）
let users = {};
let groups = [];
let messages = [];
let onlineUsers = {};
let adSettings = { ad_text: "", ad_speed: "10" };

// --- REST API エンドポイント ---

// 動作確認用
app.get('/ping', (req, res) => res.send('pong'));

// ユーザー取得 (単体)
app.get('/api/users/:id', (req, res) => {
  const user = users[req.params.id];
  if (!user) return res.status(404).json({ message: 'User not found' });
  res.json(user);
});

// ユーザー取得 (一覧)
app.get('/api/users', (req, res) => {
  res.json(Object.values(users));
});

// 新規登録
app.post('/api/register', async (req, res) => {
  const userId = String(Math.floor(1000 + Math.random() * 9000));
  const isFirstUser = Object.keys(users).length === 0;
  const newUser = {
    userId,
    userName: `ユーザー_${userId}`,
    avatar: '😊',
    password: '',
    isAdmin: isFirstUser,
    status: 'active',
    friends: []
  };
  users[userId] = newUser;

  if (supabase) {
    try {
      await supabase.from('users').insert({
        user_id: userId,
        user_name: newUser.userName,
        avatar: newUser.avatar,
        is_admin: isFirstUser,
        status: 'active'
      });
    } catch(e) { console.error('Supabase 保存エラー:', e); }
  }

  io.emit('users_updated', Object.values(users));
  res.json(newUser);
});

// ログイン
app.post('/api/login', (req, res) => {
  const { userId, password } = req.body;
  const user = users[userId];
  if (!user) return res.status(404).json({ message: 'ユーザーが存在しません' });
  if (user.password && user.password !== password) {
    return res.status(401).json({ message: 'パスワードが違います' });
  }
  res.json(user);
});

// ユーザー更新 (名前, アバター, 権限など)
app.patch('/api/users/:id', async (req, res) => {
  const user = users[req.params.id];
  if (!user) return res.status(404).json({ message: 'Not found' });
  Object.assign(user, req.body);

  if (supabase) {
    try {
      await supabase.from('users').update({
        user_name: user.userName,
        avatar: user.avatar,
        is_admin: user.isAdmin,
        status: user.status
      }).eq('user_id', user.userId);
    } catch(e) { console.error('Supabase 更新エラー:', e); }
  }

  io.emit('users_updated', Object.values(users));
  res.json(user);
});

// パスワード変更
app.post('/api/users/:id/password', (req, res) => {
  const user = users[req.params.id];
  const { oldPassword, newPassword } = req.body;
  if (!user) return res.status(404).json({ message: 'Not found' });
  if (user.password && user.password !== oldPassword) {
    return res.status(400).json({ message: '現在のパスワードが間違っています' });
  }
  user.password = newPassword;
  res.json({ success: true });
});

// アカウント削除
app.delete('/api/users/:id', async (req, res) => {
  delete users[req.params.id];
  if (supabase) {
    try { await supabase.from('users').delete().eq('user_id', req.params.id); } catch(e) {}
  }
  io.emit('users_updated', Object.values(users));
  res.json({ success: true });
});

// 友達追加
app.post('/api/friends/add', (req, res) => {
  const { userId, targetId } = req.body;
  const u1 = users[userId];
  const u2 = users[targetId];
  if (!u1 || !u2) return res.status(404).json({ message: 'ユーザーが見つかりません' });

  if (!u1.friends.includes(targetId)) u1.friends.push(targetId);
  if (!u2.friends.includes(userId)) u2.friends.push(userId);

  io.emit('users_updated', Object.values(users));
  res.json({ success: true });
});

// 友達削除
app.post('/api/friends/remove', (req, res) => {
  const { userId, targetId } = req.body;
  if (users[userId]) users[userId].friends = users[userId].friends.filter(id => id !== targetId);
  if (users[targetId]) users[targetId].friends = users[targetId].friends.filter(id => id !== userId);
  io.emit('users_updated', Object.values(users));
  res.json({ success: true });
});

// グループ機能
app.get('/api/groups', (req, res) => res.json(groups));
app.post('/api/groups', (req, res) => {
  const group = req.body;
  groups.push(group);
  io.emit('groups_updated', groups);
  res.json(group);
});
app.delete('/api/groups/:id', (req, res) => {
  groups = groups.filter(g => g.groupId !== req.params.id);
  io.emit('groups_updated', groups);
  res.json({ success: true });
});

// メッセージ一覧取得
app.get('/api/messages', (req, res) => res.json(messages));

// 管理者機能 (承認待ち一覧・お知らせ更新)
app.get('/api/admin/pending-users', (req, res) => {
  const pending = Object.values(users).filter(u => u.status === 'pending');
  res.json(pending);
});
app.post('/api/settings/ad', (req, res) => {
  adSettings = req.body;
  io.emit('ad_updated', adSettings);
  res.json({ success: true });
});

// --- Socket.io リアルタイム通信 ---
io.on('connection', (socket) => {
  // ユーザーのオンライン登録
  socket.on('setup_user', ({ userId }) => {
    onlineUsers[userId] = { state: 'online', socketId: socket.id };
    socket.userId = userId;
    io.emit('user_status_change', onlineUsers);
  });

  // メッセージ送信処理
  socket.on('send_message', async (data) => {
    messages.push(data);
    io.emit('new_message', data);

    if (supabase) {
      try {
        await supabase.from('messages').insert({
          id: data.msgId,
          from_id: data.fromId,
          to_id: data.toId,
          message: data.message,
          is_group: data.isGroup || false,
          reply_to: data.replyTo || null
        });
      } catch (err) {
        console.error('Supabase メッセージ保存エラー:', err);
      }
    }
  });

  // 既読状態の同期
  socket.on('update_read_status', (data) => {
    io.emit('read_status_updated', data);
  });

  // ログアウト処理
  socket.on('logout', ({ userId }) => {
    delete onlineUsers[userId];
    io.emit('user_status_change', onlineUsers);
  });

  // 切断（アプリ終了・オフライン化）
  socket.on('disconnect', () => {
    if (socket.userId) {
      delete onlineUsers[socket.userId];
      io.emit('user_status_change', onlineUsers);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
