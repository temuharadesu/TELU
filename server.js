const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" }
});

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

app.get('/ping', (req, res) => res.send('pong'));

io.on('connection', (socket) => {
  console.log('ユーザーが接続しました:', socket.id);

  socket.on('send_message', async (data) => {
    io.emit('receive_message', data);

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
      console.error('Supabase保存エラー:', err);
    }
  });

  socket.on('disconnect', () => {
    console.log('ユーザーが切断しました:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
