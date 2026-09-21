const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// CORS許可（すべてのオリジンからの接続を許可）
app.use(cors());
// 画像の送信に対応するため、リクエスト制限を大容量(50mb)に設定
app.use(express.json({ limit: '50mb' }));

// Supabase 接続設定 (Renderの環境変数から取得)
const SUPABASE_URL = process.env.SUPABASE_URL || "https://pvgsuzokgxatczcrxevw.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB2Z3N1em9rZ3hhdGN6Y3J4ZXZ3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk5MTI0MjYsImV4cCI6MjEwNTQ4ODQyNn0.HQN-Po9SR9go7tAnWfna_iBgPEFlYzAGGCi2sE3ZYoY";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST", "PATCH", "DELETE"]
  }
});

// オンラインステータス管理オブジェクト
const onlineStatus = {};

// --- SupabaseのDB形式 ↔ Main.jsの形式 相互変換マッピング ---
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

// リアルタイム全体同期
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

// ==========================================
// REST API エンドポイント (Main.js 完全対応)
// ==========================================

// 1. 全ユーザー取得
app.get('/api/users', async (req, res) => {
  try {
    const { data, error } = await supabase.from('users').select('*');
    if (error) throw error;
    res.json(data ? data.map(mapUser) : []);
  } catch (err) {
    res.status(500).json([]);
  }
});

// 2. 単一ユーザー取得
app.get('/api/users/:id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('users').select('*').eq('user_id', req.params.id).single();
    if (error || !data) return res.status(404).json({ message: 'ユーザーが見つかりません' });
    res.json(mapUser(data));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// 3. ログイン
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

// 4. 新規登録
app.post('/api/register', async (req, res) => {
  try {
    const newUserId = Math.floor(1000 + Math.random() * 9000).toString();
    const { data: allUsers } = await supabase.from('users').select('user_id');
    const isAdmin = (!allUsers || allUsers.length === 0); // 最初の1人は自動管理者

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

// 5. ユーザー情報更新 (名前 / アイコン / 管理者権限 / ステータス)
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

// 6. パスワード変更
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

// 7. アカウント削除
app.delete('/api/users/:id', async (req, res) => {
  try {
    await supabase.from('users').delete().eq('user_id', req.params.id);
    await broadcastUsers();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// 8. 友達追加
app.post('/api/friends/add', async (req, res) => {
  try {
    const { userId, targetId } = req.body;
    const { data: target } = await supabase.from('users').select('user_id').eq('user_id', targetId).single();
    if (!target) return res.status(400).json({ message: '該当ユーザーが見つかりません' });

    const { data: user } = await supabase.from('users').select('friends').eq('user_id', userId).single();
    let friends = Array.isArray(user.friends) ? user.friends : (user.friends ? JSON.parse(user.friends) : []);
    
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

// 9. 友達削除
app.post('/api/friends/remove', async (req, res) => {
  try {
    const { userId, targetId } = req.body;
    const { data: user } = await supabase.from('users').select('friends').eq('user_id', userId).single();
    
    if (user) {
      let friends = Array.isArray(user.friends) ? user.friends : [];
      friends = friends.filter(id => String(id) !== String(targetId));
      await supabase.from('users').update({ friends }).eq('user_id', userId);
    }

    await broadcastUsers();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// 10. グループ一覧取得
app.get('/api/groups', async (req, res) => {
  try {
    const { data } = await supabase.from('groups').select('*');
    res.json(data ? data.map(mapGroup) : []);
  } catch (err) {
    res.status(500).json([]);
  }
});

// 11. グループ作成
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

// 12. グループ削除
app.delete('/api/groups/:id', async (req, res) => {
  try {
    await supabase.from('groups').delete().eq('group_id', req.params.id);
    await broadcastGroups();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// 13. メッセージ一覧取得
app.get('/api/messages', async (req, res) => {
  try {
    let query = supabase.from('messages').select('*').order('created_at', { ascending: true });
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

// 14. 承認待ちユーザー取得
app.get('/api/admin/pending-users', async (req, res) => {
  try {
    const { data } = await supabase.from('users').select('*').eq('status', 'pending');
    res.json(data ? data.map(mapUser) : []);
  } catch (err) {
    res.status(500).json([]);
  }
});

// 15. 広告・お知らせ設定
app.post('/api/settings/ad', async (req, res) => {
  const { ad_text, ad_speed } = req.body;
  io.emit('ad_updated', { ad_text, ad_speed });
  res.json({ success: true });
});

// ==========================================
// Socket.io リアルタイム通信 (Main.js 完全対応)
// ==========================================
io.on('connection', (socket) => {
  // ユーザー接続初期化
  socket.on('setup_user', ({ userId }) => {
    if (userId) {
      onlineStatus[userId] = { state: 'online', socketId: socket.id };
      io.emit('user_status_change', onlineStatus);
    }
  });

  // ログアウト処理
  socket.on('logout', ({ userId }) => {
    if (userId && onlineStatus[userId]) {
      delete onlineStatus[userId];
      io.emit('user_status_change', onlineStatus);
    }
  });

  // メッセージ送信
  socket.on('send_message', async (data) => {
    const dbMsg = {
      msg_id: data.msgId,
      from_id: data.fromId,
      to_id: data.toId,
      message: data.message,
      timestamp: data.timestamp,
      is_group: Boolean(data.isGroup),
      reply_to: data.replyTo || null
    };

    const { error } = await supabase.from('messages').insert([dbMsg]);
    if (!error) {
      io.emit('new_message', data);
    } else {
      console.error("メッセージ保存エラー:", error);
    }
  });

  // 既読ステータス更新
  socket.on('update_read_status', (data) => {
    socket.broadcast.emit('read_status_updated', data);
  });

  // 切断時
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

// ポート起動（Render対応）
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
