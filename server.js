const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));

const SUPABASE_URL = process.env.SUPABASE_URL || "dummy";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "dummy";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST", "PATCH", "DELETE"]
  }
});

const onlineStatus = {};

// --- マッピング関数 ---
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

function mapGroup(g) {
  if (!g) return null;
  return {
    groupId: String(g.group_id),
    groupName: g.group_name || '',
    avatar: g.avatar || '👥',
    members: Array.isArray(g.members) ? g.members : (g.members ? JSON.parse(g.members) : [])
  };
}

function mapMessage(m) {
  if (!m) return null;
  return {
    msgId: String(m.msg_id || m.id),
    fromId: String(m.from_id),
    toId: String(m.to_id),
    message: m.message || '',
    timestamp: m.timestamp || m.created_at,
    isGroup: Boolean(m.is_group),
    replyTo: m.reply_to || null
  };
}

async function broadcastUsers() {
  const { data } = await supabase.from('users').select('*');
  if (data) {
    io.emit('users_updated', data.map(mapUser));
  }
}

async function broadcastGroups() {
  const { data } = await supabase.from('groups').select('*');
  if (data) {
    io.emit('groups_updated', data.map(mapGroup));
  }
}

// REST API
app.get('/api/users', async (req, res) => {
  try {
    const { data, error } = await supabase.from('users').select('*');
    if (error) throw error;
    res.json(data ? data.map(mapUser) : []);
  } catch (err) {
    res.status(500).json([]);
  }
});

app.get('/api/users/:id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('users').select('*').eq('user_id', req.params.id).single();
    if (error || !data) return res.status(404).json({ message: 'ユーザーが見つかりません' });
    res.json(mapUser(data));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { userId, password } = req.body;
    const { data: user, error } = await supabase.from('users').select('*').eq('user_id', userId).single();
    if (error || !user) return res.status(400).json({ message: 'ユーザーが存在しません' });
    if ((user.password || '') !== (password || '')) return res.status(400).json({ message: 'パスワードが一致しません' });
    
    res.json(mapUser(user));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// 新規登録 (ID重複防止ループ追加)
app.post('/api/register', async (req, res) => {
  try {
    let newUserId = '';
    let isUnique = false;
    
    while (!isUnique) {
      newUserId = Math.floor(100000 + Math.random() * 900000).toString();
      const { data } = await supabase.from('users').select('user_id').eq('user_id', newUserId).single();
      if (!data) isUnique = true;
    }

    const { data: allUsers } = await supabase.from('users').select('user_id');
    const isAdmin = (!allUsers || allUsers.length === 0);

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
    if (error) throw error;

    await broadcastUsers();
    res.json(mapUser(newUserRow));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.patch('/api/users/:id', async (req, res) => {
  try {
    const updateData = {};
    if (req.body.userName !== undefined) updateData.user_name = req.body.userName;
    if (req.body.avatar !== undefined) updateData.avatar = req.body.avatar;
    if (req.body.isAdmin !== undefined) updateData.is_admin = req.body.isAdmin;
    if (req.body.status !== undefined) updateData.status = req.body.status;

    const { error } = await supabase.from('users').update(updateData).eq('user_id', req.params.id);
    if (error) throw error;

    await broadcastUsers();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.post('/api/users/:id/password', async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    const { data: user } = await supabase.from('users').select('password').eq('user_id', req.params.id).single();
    
    if (!user || (user.password || '') !== (oldPassword || '')) {
      return res.status(400).json({ message: '現在のパスワードが一致しません' });
    }

    await supabase.from('users').update({ password: newPassword }).eq('user_id', req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.delete('/api/users/:id', async (req, res) => {
  try {
    await supabase.from('users').delete().eq('user_id', req.params.id);
    await broadcastUsers();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.post('/api/friends/add', async (req, res) => {
  try {
    const { userId, targetId } = req.body;
    const { data: target } = await supabase.from('users').select('user_id').eq('user_id', targetId).single();
    if (!target) return res.status(400).json({ message: '該当ユーザーが見つかりません' });

    const { data: user } = await supabase.from('users').select('friends').eq('user_id', userId).single();
    let friends = Array.isArray(user?.friends) ? user.friends : (user?.friends ? JSON.parse(user.friends) : []);
    
    if (!friends.includes(targetId)) {
      friends.push(targetId);
      await supabase.from('users').update({ friends }).eq('user_id', userId);
    }

    await broadcastUsers();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// 友達削除 (パース処理を修復)
app.post('/api/friends/remove', async (req, res) => {
  try {
    const { userId, targetId } = req.body;
    const { data: user } = await supabase.from('users').select('friends').eq('user_id', userId).single();
    
    if (user) {
      let friends = Array.isArray(user.friends) ? user.friends : (user.friends ? JSON.parse(user.friends) : []);
      friends = friends.filter(id => String(id) !== String(targetId));
      await supabase.from('users').update({ friends }).eq('user_id', userId);
    }

    await broadcastUsers();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/groups', async (req, res) => {
  try {
    const { data } = await supabase.from('groups').select('*');
    res.json(data ? data.map(mapGroup) : []);
  } catch (err) {
    res.status(500).json([]);
  }
});

app.post('/api/groups', async (req, res) => {
  try {
    const { groupId, groupName, avatar, members } = req.body;
    const newGroup = {
      group_id: groupId,
      group_name: groupName,
      avatar: avatar || '👥',
      members: members || []
    };

    await supabase.from('groups').insert([newGroup]);
    await broadcastGroups();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.delete('/api/groups/:id', async (req, res) => {
  try {
    await supabase.from('groups').delete().eq('group_id', req.params.id);
    await broadcastGroups();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// メッセージ取得 (timestampフォールバック付きソート)
app.get('/api/messages', async (req, res) => {
  try {
    let query = supabase.from('messages').select('*').order('timestamp', { ascending: true });
    if (req.query.limit) {
      query = query.limit(parseInt(req.query.limit));
    }
    const { data, error } = await query;
    if (error) throw error;
    res.json(data ? data.map(mapMessage) : []);
  } catch (err) {
    res.status(500).json([]);
  }
});

app.get('/api/admin/pending-users', async (req, res) => {
  try {
    const { data } = await supabase.from('users').select('*').eq('status', 'pending');
    res.json(data ? data.map(mapUser) : []);
  } catch (err) {
    res.status(500).json([]);
  }
});

app.post('/api/settings/ad', async (req, res) => {
  const { ad_text, ad_speed } = req.body;
  io.emit('ad_updated', { ad_text, ad_speed });
  res.json({ success: true });
});

// Socket.io 通信設定
io.on('connection', (socket) => {
  socket.on('setup_user', ({ userId }) => {
    if (userId) {
      onlineStatus[userId] = { state: 'online', socketId: socket.id };
      io.emit('user_status_change', onlineStatus);
    }
  });

  socket.on('logout', ({ userId }) => {
    if (userId && onlineStatus[userId]) {
      delete onlineStatus[userId];
      io.emit('user_status_change', onlineStatus);
    }
  });

  socket.on('send_message', async (data) => {
    const dbMsg = {
      msg_id: data.msgId,
      from_id: data.fromId,
      to_id: data.toId,
      message: data.message,
      timestamp: data.timestamp || new Date().toISOString(),
      is_group: Boolean(data.isGroup),
      reply_to: data.replyTo || null
    };

    const { error } = await supabase.from('messages').insert([dbMsg]);
    if (!error) {
      io.emit('new_message', data);
    } else {
      console.error("メッセージ保存エラー:", error);
      socket.emit('message_send_failed', { msgId: data.msgId, error: error.message });
    }
  });

  socket.on('update_read_status', (data) => {
    socket.broadcast.emit('read_status_updated', data);
  });

  socket.on('disconnect', () => {
    for (const uId in onlineStatus) {
      if (onlineStatus[uId].socketId === socket.id) {
        delete onlineStatus[uId];
        io.emit('user_status_change', onlineStatus);
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
