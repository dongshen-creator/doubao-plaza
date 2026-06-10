// Supabase 配置 — 逗包广场聊天
(function () {
  const SUPABASE_URL = 'https://qwslopgbfkvnxrkqlvjl.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF3c2xvcGdiZmt2bnhya3FsdmpsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEwMjgzNjksImV4cCI6MjA5NjYwNDM2OX0.774LBSE3xSHtOM8SN2O3Pj3jz9YqEMGacR4CsYT41T0';

  window.__SB = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    realtime: {
      params: {
        eventsPerSecond: 10
      }
    }
  });
})();
