const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Supabase 接続設定
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

// オンライン状態の管理
const onlineStatus = {};

// データ変換ヘルパー関数
function mapUser(u) {
  if (!u) return null;
  return {
    userId: String(u.user_id),
    userName: u.user_name || 'ユーザー',
    avatar: u.avatar || '😊',
    password: u.password || '',
    isAdmin: Boolean(u.is_admin),
    status: u.status || 'active',
    friends: Array.isArray(u.friends) ? u.friends : (u.friends ? (typeof u.friends === 'string' ? JSON.parse(u.friends) : u.friends) : [])
  };
}

function mapGroup(g) {
  if (!g) return null;
  return {
    groupId: String(g.group_id),
    groupName: g.group_name || '',
    avatar: g.avatar || '👥',
    members: Array.isArray(g.members) ? g.members : (g.members ? (typeof g.members === 'string' ? JSON.parse(g.members) : g.members) : [])
  };
}

function mapMessage(m) {
  if (!m) return null;
  return {
    msgId: String(m.id || m.msg_id),
    fromId: String(m.from_id),
    toId: String(m.to_id),
    message: m.message || '',
    timestamp: m.created_at || m.timestamp,
    isGroup: Boolean(m.is_group),
    replyTo: m.reply_to || null
  };
}

// リアルタイムブロードキャストヘルパー
async function broadcastUsers() {
  try {
    const { data } = await supabase.from('users').select('*');
    if (data) io.emit('users_updated', data.map(mapUser));
  } catch (err) {
    console.error("broadcastUsers エラー:", err);
  }
}

async function broadcastGroups() {
  try {
    const { data } = await supabase.from('groups').select('*');
    if (data) io.emit('groups_updated', data.map(mapGroup));
  } catch (err) {
    console.error("broadcastGroups エラー:", err);
  }
}

// REST API エンドポイント

// ユーザー一覧取得
app.get('/api/users', async (req, res) => {
  try {
    const { data, error } = await supabase.from('users').select('*');
    if (error) throw error;
    res.json(data ? data.map(mapUser) : []);
  } catch (err) {
    console.error("ユーザー取得エラー:", err);
    res.status(500).json([]);
  }
});

// 単一ユーザー取得
app.get('/api/users/:id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('users').select('*').eq('user_id', req.params.id).single();
    if (error || !data) return res.status(404).json({ message: 'ユーザーが見つかりません' });
    res.json(mapUser(data));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ログイン
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

// 新規ユーザー登録
app.post('/api/register', async (req, res) => {
  try {
    let newUserId = '';
    let isUnique = false;
    let attempts = 0;
    
    while (!isUnique && attempts < 10) {
      newUserId = Math.floor(100000 + Math.random() * 900000).toString();
      const { data } = await supabase.from('users').select('user_id').eq('user_id', newUserId).single();
      if (!data) isUnique = true;
      attempts++;
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

// ユーザー情報更新
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

// パスワード変更
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

// ユーザー削除
app.delete('/api/users/:id', async (req, res) => {
  try {
    await supabase.from('users').delete().eq('user_id', req.params.id);
    await broadcastUsers();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// 友達追加
app.post('/api/friends/add', async (req, res) => {
  try {
    const { userId, targetId } = req.body;
    const { data: target } = await supabase.from('users').select('user_id').eq('user_id', targetId).single();
    if (!target) return res.status(400).json({ message: '該当ユーザーが見つかりません' });

    const { data: user } = await supabase.from('users').select('friends').eq('user_id', userId).single();
    let friends = Array.isArray(user?.friends) ? user.friends : (user?.friends ? (typeof user.friends === 'string' ? JSON.parse(user.friends) : user.friends) : []);
    
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

// 友達削除
app.post('/api/friends/remove', async (req, res) => {
  try {
    const { userId, targetId } = req.body;
    const { data: user } = await supabase.from('users').select('friends').eq('user_id', userId).single();
    
    if (user) {
      let friends = Array.isArray(user.friends) ? user.friends : (user.friends ? (typeof user.friends === 'string' ? JSON.parse(user.friends) : user.friends) : []);
      friends = friends.filter(id => String(id) !== String(targetId));
      await supabase.from('users').update({ friends }).eq('user_id', userId);
    }

    await broadcastUsers();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// グループ一覧取得
app.get('/api/groups', async (req, res) => {
  try {
    const { data } = await supabase.from('groups').select('*');
    res.json(data ? data.map(mapGroup) : []);
  } catch (err) {
    res.status(500).json([]);
  }
});

// グループ作成
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

// グループ情報（メンバー一覧含む）の更新
app.patch('/api/groups/:id', async (req, res) => {
  try {
    const updateData = {};
    if (req.body.groupName !== undefined) updateData.group_name = req.body.groupName;
    if (req.body.avatar !== undefined) updateData.avatar = req.body.avatar;
    if (req.body.members !== undefined) updateData.members = req.body.members;

    const { error } = await supabase.from('groups').update(updateData).eq('group_id', req.params.id);
    if (error) throw error;

    await broadcastGroups();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// グループ削除
app.delete('/api/groups/:id', async (req, res) => {
  try {
    await supabase.from('groups').delete().eq('group_id', req.params.id);
    await broadcastGroups();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// メッセージ履歴取得
app.get('/api/messages', async (req, res) => {
  try {
    let query = supabase.from('messages').select('*').order('created_at', { ascending: true });
    if (req.query.limit) {
      query = query.limit(parseInt(req.query.limit, 10));
    }
    const { data, error } = await query;
    if (error) throw error;
    res.json(data ? data.map(mapMessage) : []);
  } catch (err) {
    console.error("メッセージ取得エラー:", err);
    res.status(500).json([]);
  }
});

// 承認待ちユーザー一覧（管理者用）
app.get('/api/admin/pending-users', async (req, res) => {
  try {
    const { data } = await supabase.from('users').select('*').eq('status', 'pending');
    res.json(data ? data.map(mapUser) : []);
  } catch (err) {
    res.status(500).json([]);
  }
});

// 広告設定更新
app.post('/api/settings/ad', async (req, res) => {
  const { ad_text, ad_speed } = req.body;
  io.emit('ad_updated', { ad_text, ad_speed });
  res.json({ success: true });
});

// Socket.io リアルタイム通信
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
    let replyData = null;
    if (data.replyTo) {
      replyData = typeof data.replyTo === 'object' ? data.replyTo : { text: String(data.replyTo) };
    }

    const dbMsg = {
      id: String(data.msgId),
      from_id: String(data.fromId),
      to_id: String(data.toId),
      message: String(data.message || ''),
      created_at: data.timestamp || new Date().toISOString(),
      is_group: Boolean(data.isGroup),
      reply_to: replyData
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
