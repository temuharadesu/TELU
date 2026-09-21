// ==========================================
// Render バックエンドサーバー (server.js)
// ==========================================
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' })); // 画像送信対応

// --- Supabase 接続設定 ---
// Renderの環境変数（Environment Variables）に設定するか、直接文字列で書き換えてください
const SUPABASE_URL = process.env.SUPABASE_URL || "https://pvgsuzokgxatczcrxevw.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB2Z3N1em9rZ3hhdGN6Y3J4ZXZ3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk5MTI0MjYsImV4cCI6MjEwNTQ4ODQyNn0.HQN-Po9SR9go7tAnWfna_iBgPEFlYzAGGCi2sE3ZYoY";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// Admin設定
const ADMIN_PASS = "桜桜今咲き誇る刹那に散り行く定と知って";

// --- ヘルパー関数 ---
function mapUser(u) {
  if (!u) return null;
  return {
    userId: String(u.user_id),
    userName: u.user_name || 'ユーザー',
    avatar: u.avatar || '😊',
    password: u.password || '',
    isAdmin: Boolean(u.is_admin),
    status: u.status || 'active',
    friends: Array.isArray(u.friends) ? u.friends : (u.friends ? JSON.parse(u.friends) : [])
  };
}

function mapMessage(m) {
  if (!m) return null;
  return {
    msgId: String(m.id),
    id: String(m.id),
    fromId: String(m.from_id),
    toId: String(m.to_id),
    message: m.message || '',
    isGroup: Boolean(m.is_group),
    replyTo: m.reply_to || null,
    timestamp: m.created_at
  };
}

function mapGroup(g) {
  if (!g) return null;
  return {
    groupId: String(g.group_id),
    groupName: g.group_name || '',
    avatar: g.avatar || '👥',
    members: Array.isArray(g.members) ? g.members : (g.members ? JSON.parse(g.members) : [])
  };
}

// --- API エンドポイント ---

// 1. 初期データ一括取得
app.get('/api/init', async (req, res) => {
  try {
    const [uRes, gRes, mRes] = await Promise.all([
      supabase.from('users').select('*'),
      supabase.from('groups').select('*'),
      supabase.from('messages').select('*').order('created_at', { ascending: true })
    ]);

    const users = {};
    if (uRes.data) uRes.data.forEach(u => { const mapped = mapUser(u); users[mapped.userId] = mapped; });
    const groups = gRes.data ? gRes.data.map(mapGroup) : [];
    const messages = mRes.data ? mRes.data.map(mapMessage) : [];

    res.json({ users, groups, messages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. ユーザー取得 / 登録 / ログイン
app.post('/api/login', async (req, res) => {
  const { userId, password } = req.body;
  const { data: user, error } = await supabase.from('users').select('*').eq('user_id', userId).single();
  if (error || !user) return res.status(404).json({ error: 'ユーザーが見つかりません' });
  if ((user.password || '') !== (password || '')) return res.status(401).json({ error: 'パスワードが違います' });
  res.json({ user: mapUser(user) });
});

app.post('/api/register', async (req, res) => {
  const newUserId = Math.floor(1000 + Math.random() * 9000).toString();
  const { data: existing } = await supabase.from('users').select('user_id');
  const isAdmin = (!existing || existing.length === 0);

  const newUserRow = {
    user_id: newUserId,
    user_name: 'ユーザー_' + newUserId,
    avatar: '😊',
    password: '',
    is_admin: isAdmin,
    status: 'active',
    friends: []
  };

  const { error } = await supabase.from('users').insert([newUserRow]);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ user: mapUser(newUserRow) });
});

// 3. ユーザープロファイル更新
app.post('/api/user/update', async (req, res) => {
  const { userId, userName, avatar, password, status, is_admin } = req.body;
  const updateData = {};
  if (userName !== undefined) updateData.user_name = userName;
  if (avatar !== undefined) updateData.avatar = avatar;
  if (password !== undefined) updateData.password = password;
  if (status !== undefined) updateData.status = status;
  if (is_admin !== undefined) updateData.is_admin = is_admin;

  const { error } = await supabase.from('users').update(updateData).eq('user_id', userId);
  if (error) return res.status(500).json({ error: error.message });
  
  io.emit('user-updated', { userId, ...updateData });
  res.json({ success: true });
});

// 4. 友達追加
app.post('/api/friends/add', async (req, res) => {
  const { userId, targetId } = req.body;
  const { data: user } = await supabase.from('users').select('friends').eq('user_id', userId).single();
  if (!user) return res.status(404).json({ error: 'ユーザーが存在しません' });

  let friends = Array.isArray(user.friends) ? user.friends : (user.friends ? JSON.parse(user.friends) : []);
  if (!friends.includes(targetId)) friends.push(targetId);

  const { error } = await supabase.from('users').update({ friends }).eq('user_id', userId);
  if (error) return res.status(500).json({ error: error.message });

  io.emit('user-updated', { userId, friends });
  res.json({ success: true, friends });
});

// 5. グループ作成
app.post('/api/groups/create', async (req, res) => {
  const { groupName, members } = req.body;
  const newGroup = {
    group_id: "g_" + Date.now(),
    group_name: groupName,
    avatar: "👥",
    members: members
  };
  const { error } = await supabase.from('groups').insert([newGroup]);
  if (error) return res.status(500).json({ error: error.message });

  const mapped = mapGroup(newGroup);
  io.emit('group-created', mapped);
  res.json({ group: mapped });
});

// --- Socket.io リアルタイム通信 ---
io.on('connection', (socket) => {
  // メッセージ送信
  socket.on('send-message', async (data) => {
    const { fromId, toId, message, isGroup, replyTo } = data;
    const msgId = "m_" + Date.now();

    const dbMsg = {
      id: msgId,
      from_id: String(fromId).trim(),
      to_id: String(toId).trim(),
      message: message,
      is_group: Boolean(isGroup),
      reply_to: replyTo || null,
      created_at: new Date().toISOString()
    };

    // DBへ保存
    const { error } = await supabase.from('messages').insert([dbMsg]);
    if (!error) {
      const mapped = mapMessage(dbMsg);
      // 全クライアントにリアルタイム転送
      io.emit('receive-message', mapped);
    }
  });

  // 既読状態の共有
  socket.on('read-status', (data) => {
    socket.broadcast.emit('read-status', data);
  });

  // 管理者お知らせ
  socket.on('admin-ad', (data) => {
    io.emit('admin-ad', data);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Render Server running on port ${PORT}`);
});
