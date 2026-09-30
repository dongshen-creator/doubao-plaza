-- v9.0: AUDIT FIX [6.6] [6.2] Supabase RLS 收紧
--
-- 背景：public schema 下 24 张表存在 roles={public} qual='true' 的全放行宽政策，
--       匿名（anon）API Key 可直读直写全部业务表；audit_logs/todos 另有 anon 专有政策。
-- 修法：
--   1) 删除 anon 专有政策（audit_logs/todos 项目代码零引用，删除后仅 service_role 可访问）
--   2) 删除 channel_join_requests 上冗余的“任何人可*”宽政策（严格 authenticated 政策已存在）
--   3) 将其余 roles={public} 政策【原名、原 cmd、原 qual/with_check】重建为 TO authenticated
--      （登录用户携带后端签发的 authenticated JWT，行为不变；匿名请求被 RLS 过滤为空/403）
--   4) 保留 plugins 公开可读（插件目录有意公开，且无任何写政策）
-- 回滚脚本：migrations/supabase-rls-rollback-v9.0.sql
--
-- 前置验证（本迁移前已完成）：
--   - index.html 全部 .from() 调用均在 currentUser/session 门卫之后（登录态执行）
--   - functions/api/presence.js 使用 signSupabaseJWT 签发 authenticated JWT
--   - tavern.html / developer.html 无任何 .from() 直连
--   - pages 为 storage 桶（storage.objects 不受本迁移影响）

DO $$
DECLARE
  pols jsonb;
  pol  jsonb;
BEGIN
  -- ---------- 1) 删除 anon 专有政策 ----------
  DROP POLICY IF EXISTS "audit_logs anon read"  ON public.audit_logs;
  DROP POLICY IF EXISTS "audit_logs anon write" ON public.audit_logs;
  DROP POLICY IF EXISTS "todos anon all"        ON public.todos;

  -- ---------- 2) 删除 channel_join_requests 冗余宽政策 ----------
  DROP POLICY IF EXISTS "任何人可读取入群申请" ON public.channel_join_requests;
  DROP POLICY IF EXISTS "任何人可插入入群申请" ON public.channel_join_requests;
  DROP POLICY IF EXISTS "任何人可更新入群申请" ON public.channel_join_requests;
  DROP POLICY IF EXISTS "任何人可删除入群申请" ON public.channel_join_requests;

  -- ---------- 3) 物化待转换政策列表（先快照，避免游标边改边读）----------
  --    范围：public 模式全部 roles={public} 政策，排除有意公开的 plugins 公开可读
  --    （第 1、2 步已删除的政策此时已不在 pg_policies 中）
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'p', policyname, 't', tablename, 'c', cmd,
           'q', qual, 'w', with_check)), '[]'::jsonb)
    INTO pols
    FROM pg_policies
   WHERE schemaname = 'public'
     AND roles = ARRAY['public']::name[]
     AND policyname <> 'plugins 公开可读';

  -- ---------- 4) 逐条原名重建为 TO authenticated ----------
  FOR pol IN SELECT * FROM jsonb_array_elements(pols) LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I',
                   pol->>'p', pol->>'t');
    IF pol->>'c' = 'INSERT' THEN
      EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (%s)',
                     pol->>'p', pol->>'t', COALESCE(pol->>'w', 'true'));
    ELSE
      EXECUTE format('CREATE POLICY %I ON public.%I FOR %s TO authenticated USING (%s)%s',
                     pol->>'p', pol->>'t', pol->>'c',
                     COALESCE(pol->>'q', 'true'),
                     CASE WHEN pol->>'w' IS NOT NULL
                          THEN format(' WITH CHECK (%s)', pol->>'w')
                          ELSE '' END);
    END IF;
  END LOOP;
END $$;

-- 迁移后预期：
--   pg_policies 中 roles 含 public/anon 的政策仅剩 'plugins 公开可读'
--   其余业务表政策全部为 TO authenticated（原严格政策保持不变）
