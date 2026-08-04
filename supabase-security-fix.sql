-- ============================================================================
-- 逗包用户广场 · 安全修复脚本（2026-08-01）
-- 对应审计报告：C1' XSS / RLS 读取层全开放 / 匿名写 / sign_auth_jwt 地雷 / advisor 告警
--
-- 修复清单：
--   R1 读侧 RLS 收紧：私聊房间(chat_messages/chat_room_members/chat_rooms/chat_reactions)
--      仅"公开频道(游客可见) / 本人 / 房主 / 管理员"可读；管理类数据(admins/muted/banned/unread/
--      invites/join_requests/questionnaires/answers)仅相关角色可读
--   R2 敏感列保护：chat_channel_settings 的 admission_password / admission_questionnaire(含正确答案)
--      对 anon/authenticated 列级不可读，入群校验改为服务端 RPC（verify_admission）
--   R3 写残留收紧：chat_tool_cards（匿名可写→仅本人）、channel_questionnaire_answers（匿名可删）、
--      public_channels（任意登录用户可写→仅开发者白名单）
--   R4 服务端门禁 RPC：verify_admission / get_admission_questions / get_admission_settings / redeem_invite
--      （邀请码兑换改为原子递增，替代客户端直 UPDATE，修复线上静默失败）
--   R5 函数加固：sign_auth_jwt REVOKE anon/authenticated + 固定 search_path；
--      increment_unread REVOKE 外部调用；app_user_id / current_d1_user_id / cleanup_old_chat_messages
--      固定 search_path
--
-- 幂等：所有 DROP ... IF EXISTS / CREATE OR REPLACE，可重复执行
-- 注意：应用后需同步前端 index.html（joinChannel/问卷/邀请码/管理面板已改走 RPC）
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. 辅助判定函数（SECURITY DEFINER，供 RLS 策略使用，避免同表递归/绕过 RLS）
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_channel_public(p_room_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM chat_rooms WHERE id = p_room_id AND type = 'channel');
$$;

CREATE OR REPLACE FUNCTION public.is_room_creator(p_room_id text, p_user_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM chat_rooms WHERE id = p_room_id AND created_by = p_user_id);
$$;

CREATE OR REPLACE FUNCTION public.is_room_member(p_room_id text, p_user_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM chat_room_members WHERE room_id = p_room_id AND user_id = p_user_id);
$$;

CREATE OR REPLACE FUNCTION public.is_room_admin(p_room_id text, p_user_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM chat_admins WHERE room_id = p_room_id AND user_id = p_user_id);
$$;

CREATE OR REPLACE FUNCTION public.is_developer(p_user_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM developers WHERE user_id = p_user_id);
$$;

GRANT EXECUTE ON FUNCTION public.is_channel_public(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_room_creator(text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_room_member(text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_room_admin(text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_developer(text) TO anon, authenticated;

-- ----------------------------------------------------------------------------
-- 1. developers 开发者白名单表（public_channels 写权限依据；由 postgres/service_role 维护）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.developers (
  user_id text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.developers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "dev_read_self" ON public.developers;
CREATE POLICY "dev_read_self" ON public.developers FOR SELECT USING (app_user_id() = user_id);
-- 写：不授予 anon/authenticated（无策略=拒绝），仅 postgres/service_role 可维护

-- ----------------------------------------------------------------------------
-- 2. chat_channel_settings 敏感列保护（列级权限）
-- ----------------------------------------------------------------------------
REVOKE SELECT (admission_password, admission_questionnaire) ON public.chat_channel_settings FROM anon, authenticated;

-- ----------------------------------------------------------------------------
-- 3. 读侧 RLS 收紧
-- ----------------------------------------------------------------------------
-- chat_rooms：公开频道(channel)游客可见；私聊房间仅 成员/房主/本人
DROP POLICY IF EXISTS "chat_rooms_read" ON chat_rooms;
CREATE POLICY "chat_rooms_read" ON chat_rooms FOR SELECT USING (
  type = 'channel'
  OR created_by = app_user_id()
  OR public.is_room_member(id, app_user_id())
);

-- chat_room_members：公开频道游客可见；私聊房间仅成员/房主
DROP POLICY IF EXISTS "chat_room_members_read" ON chat_room_members;
CREATE POLICY "chat_room_members_read" ON chat_room_members FOR SELECT USING (
  public.is_channel_public(room_id)
  OR public.is_room_creator(room_id, app_user_id())
  OR public.is_room_member(room_id, app_user_id())
);

-- chat_messages：公开频道游客可见；私聊房间仅成员/房主
DROP POLICY IF EXISTS "chat_messages_read" ON chat_messages;
CREATE POLICY "chat_messages_read" ON chat_messages FOR SELECT USING (
  public.is_channel_public(room_id)
  OR public.is_room_creator(room_id, app_user_id())
  OR public.is_room_member(room_id, app_user_id())
);

-- chat_reactions：同上
DROP POLICY IF EXISTS "chat_reactions_read" ON chat_reactions;
CREATE POLICY "chat_reactions_read" ON chat_reactions FOR SELECT USING (
  public.is_channel_public(room_id)
  OR public.is_room_creator(room_id, app_user_id())
  OR public.is_room_member(room_id, app_user_id())
);

-- chat_admins：本人 / 房主 / 管理员
DROP POLICY IF EXISTS "chat_admins_read" ON chat_admins;
CREATE POLICY "chat_admins_read" ON chat_admins FOR SELECT USING (
  user_id = app_user_id()
  OR public.is_room_creator(room_id, app_user_id())
  OR public.is_room_admin(room_id, app_user_id())
);

-- chat_muted：本人 / 房主 / 管理员
DROP POLICY IF EXISTS "chat_muted_read" ON chat_muted;
CREATE POLICY "chat_muted_read" ON chat_muted FOR SELECT USING (
  user_id = app_user_id()
  OR public.is_room_creator(room_id, app_user_id())
  OR public.is_room_admin(room_id, app_user_id())
);

-- chat_banned：本人 / 房主 / 管理员
DROP POLICY IF EXISTS "chat_banned_read" ON chat_banned;
CREATE POLICY "chat_banned_read" ON chat_banned FOR SELECT USING (
  user_id = app_user_id()
  OR public.is_room_creator(room_id, app_user_id())
  OR public.is_room_admin(room_id, app_user_id())
);

-- chat_unread：仅本人
DROP POLICY IF EXISTS "chat_unread_read" ON chat_unread;
CREATE POLICY "chat_unread_read" ON chat_unread FOR SELECT USING (
  app_user_id() = user_id
);

-- channel_invites：仅 房主/管理员（兑换走 redeem_invite RPC）
DROP POLICY IF EXISTS "channel_invites_read" ON channel_invites;
CREATE POLICY "channel_invites_read" ON channel_invites FOR SELECT USING (
  public.is_room_creator(room_id, app_user_id())
  OR public.is_room_admin(room_id, app_user_id())
);

-- channel_join_requests：本人 / 房主 / 管理员
DROP POLICY IF EXISTS "任何人可读取入群申请" ON channel_join_requests;
CREATE POLICY "join_requests_read" ON channel_join_requests FOR SELECT USING (
  user_id = app_user_id()
  OR public.is_room_creator(room_id, app_user_id())
  OR public.is_room_admin(room_id, app_user_id())
);

-- channel_questionnaires（含正确答案）：仅 房主/管理员
DROP POLICY IF EXISTS "channel_questionnaires_read" ON channel_questionnaires;
CREATE POLICY "channel_questionnaires_read" ON channel_questionnaires FOR SELECT USING (
  public.is_room_creator(room_id, app_user_id())
  OR public.is_room_admin(room_id, app_user_id())
);

-- channel_questionnaire_answers：仅 本人(申请人) / 房主 / 管理员
DROP POLICY IF EXISTS "channel_questionnaire_answers_read" ON channel_questionnaire_answers;
CREATE POLICY "channel_questionnaire_answers_read" ON channel_questionnaire_answers FOR SELECT USING (
  EXISTS (SELECT 1 FROM channel_join_requests j WHERE j.id = request_id AND (j.user_id = app_user_id()))
  OR EXISTS (SELECT 1 FROM channel_join_requests j WHERE j.id = request_id AND public.is_room_creator(j.room_id, app_user_id()))
  OR EXISTS (SELECT 1 FROM channel_join_requests j WHERE j.id = request_id AND public.is_room_admin(j.room_id, app_user_id()))
);

-- chat_tool_cards：读 仅成员/房主/管理员（前端零引用，保守收紧）
DROP POLICY IF EXISTS "ctcard_read" ON chat_tool_cards;
CREATE POLICY "ctcard_read" ON chat_tool_cards FOR SELECT USING (
  public.is_room_member(room_id, app_user_id())
  OR public.is_room_creator(room_id, app_user_id())
  OR public.is_room_admin(room_id, app_user_id())
);

-- ----------------------------------------------------------------------------
-- 4. 写残留收紧
-- ----------------------------------------------------------------------------
-- chat_tool_cards：仅本人可写
DROP POLICY IF EXISTS "ctcard_insert" ON chat_tool_cards;
CREATE POLICY "ctcard_insert" ON chat_tool_cards FOR INSERT TO authenticated
WITH CHECK (app_user_id() = user_id);
DROP POLICY IF EXISTS "ctcard_update" ON chat_tool_cards;
CREATE POLICY "ctcard_update" ON chat_tool_cards FOR UPDATE TO authenticated
USING (app_user_id() = user_id);
DROP POLICY IF EXISTS "ctcard_delete" ON chat_tool_cards;
CREATE POLICY "ctcard_delete" ON chat_tool_cards FOR DELETE TO authenticated
USING (app_user_id() = user_id);

-- channel_questionnaire_answers：删除 仅本人 / 房主 / 管理员
DROP POLICY IF EXISTS "channel_questionnaire_answers_delete" ON channel_questionnaire_answers;
CREATE POLICY "channel_questionnaire_answers_delete" ON channel_questionnaire_answers FOR DELETE USING (
  EXISTS (SELECT 1 FROM channel_join_requests j WHERE j.id = request_id AND (j.user_id = app_user_id()))
  OR EXISTS (SELECT 1 FROM channel_join_requests j WHERE j.id = request_id AND public.is_room_creator(j.room_id, app_user_id()))
  OR EXISTS (SELECT 1 FROM channel_join_requests j WHERE j.id = request_id AND public.is_room_admin(j.room_id, app_user_id()))
);

-- public_channels：仅 开发者白名单 或 频道创建者 可写（读保持公开）
-- 注：Supabase 无 users 表，开发者身份无法自动同步（数据在 Cloudflare D1），
--     因此同时保留频道创建者写权限，避免开发者面板管理他人频道时静默失败
DROP POLICY IF EXISTS "public_channels_insert" ON public_channels;
CREATE POLICY "public_channels_insert" ON public_channels FOR INSERT TO authenticated
WITH CHECK (public.is_developer(app_user_id())
  OR EXISTS (SELECT 1 FROM chat_rooms c WHERE c.id = room_id AND c.created_by = app_user_id()));
DROP POLICY IF EXISTS "public_channels_update" ON public_channels;
CREATE POLICY "public_channels_update" ON public_channels FOR UPDATE TO authenticated
USING (public.is_developer(app_user_id())
  OR EXISTS (SELECT 1 FROM chat_rooms c WHERE c.id = room_id AND c.created_by = app_user_id()));
DROP POLICY IF EXISTS "public_channels_delete" ON public_channels;
CREATE POLICY "public_channels_delete" ON public_channels FOR DELETE TO authenticated
USING (public.is_developer(app_user_id())
  OR EXISTS (SELECT 1 FROM chat_rooms c WHERE c.id = room_id AND c.created_by = app_user_id()));

-- ----------------------------------------------------------------------------
-- 5. 服务端门禁 RPC（SECURITY DEFINER + 固定 search_path）
-- ----------------------------------------------------------------------------
-- 5.1 verify_admission：服务端校验入群密码/问卷答案；返回 {ok, need_password?, error?}
--     前端不再读取 admission_password / admission_questionnaire（正确答案）
CREATE OR REPLACE FUNCTION public.verify_admission(
  p_room_id text,
  p_password text DEFAULT NULL,
  p_answers jsonb DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_settings chat_channel_settings%ROWTYPE;
  v_mode text;
  v_q jsonb;
  v_a jsonb;
  v_item jsonb;
  v_type text;
  v_correct jsonb;
  v_u jsonb;
  v_ans text;
  v_i int;
  v_j int;
  v_found boolean;
  v_has_password boolean;
  v_c_arr text[];
  v_u_arr text[];
BEGIN
  SELECT * INTO v_settings FROM chat_channel_settings WHERE room_id = p_room_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', '频道不存在');
  END IF;

  v_mode := COALESCE(NULLIF(v_settings.admission_mode, ''), NULLIF(v_settings.admission, ''), 'open');
  IF v_mode = 'open' THEN
    RETURN jsonb_build_object('ok', true);
  END IF;
  IF v_mode = 'approval' THEN
    RETURN jsonb_build_object('ok', false, 'error', '该频道需申请审批');
  END IF;

  v_has_password := v_settings.admission_password IS NOT NULL AND v_settings.admission_password <> '';

  -- 密码校验（password / composite 模式）
  IF v_mode IN ('password', 'composite') AND v_has_password THEN
    IF p_password IS NULL OR p_password = '' THEN
      RETURN jsonb_build_object('ok', false, 'need_password', true, 'error', '请输入入群密码');
    END IF;
    IF p_password <> v_settings.admission_password THEN
      RETURN jsonb_build_object('ok', false, 'error', '密码错误');
    END IF;
  END IF;

  -- 问卷校验（questionnaire / composite 模式）
  v_q := v_settings.admission_questionnaire::jsonb; -- 列类型为 json，显式转 jsonb
  IF v_mode IN ('questionnaire', 'composite') AND jsonb_typeof(v_q) = 'array' AND jsonb_array_length(v_q) > 0 THEN
    IF p_answers IS NULL OR jsonb_typeof(p_answers) <> 'array' THEN
      RETURN jsonb_build_object('ok', false, 'error', '请完成入群问卷');
    END IF;
    FOR v_i IN 0 .. jsonb_array_length(v_q) - 1 LOOP
      v_item := v_q->v_i;
      v_type := v_item->>'type';
      IF v_type IS NULL OR v_type = 'fill' THEN
        CONTINUE; -- 开放题不校验，答案走审批流程
      END IF;
      -- 取该题用户答案
      v_found := false;
      v_ans := NULL;
      FOR v_j IN 0 .. jsonb_array_length(p_answers) - 1 LOOP
        IF (p_answers->v_j->>'index')::int = v_i THEN
          v_ans := p_answers->v_j->>'value';
          v_found := true;
          EXIT;
        END IF;
      END LOOP;
      IF NOT v_found THEN
        RETURN jsonb_build_object('ok', false, 'error', '请完成全部题目');
      END IF;
      IF v_type IN ('single', 'choice', 'multiple') THEN
        v_correct := v_item->'correct_answer';
        IF jsonb_typeof(v_correct) <> 'array' THEN
          v_correct := jsonb_build_array(v_correct);
        END IF;
        BEGIN
          v_u := COALESCE(v_ans, '[]')::jsonb;
        EXCEPTION WHEN OTHERS THEN
          v_u := jsonb_build_array(v_ans);
        END;
        IF jsonb_typeof(v_u) <> 'array' THEN
          v_u := jsonb_build_array(v_ans);
        END IF;
        -- 归一化为文本数组比较（兼容数字索引与字符串答案，忽略顺序）
        SELECT array_agg(e #>> '{}') INTO v_c_arr FROM jsonb_array_elements(v_correct) e;
        SELECT array_agg(e #>> '{}') INTO v_u_arr FROM jsonb_array_elements(v_u) e;
        IF NOT (v_u_arr <@ v_c_arr AND v_c_arr <@ v_u_arr) THEN
          RETURN jsonb_build_object('ok', false, 'error', '未通过入群测试，请重新作答');
        END IF;
      ELSIF v_type = 'fill_standard' THEN
        IF lower(trim(COALESCE(v_ans, ''))) <> lower(trim(COALESCE(v_item->>'correct_answer', ''))) THEN
          RETURN jsonb_build_object('ok', false, 'error', '未通过入群测试，请重新作答');
        END IF;
      END IF;
    END LOOP;
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$$;

-- 5.2 get_admission_questions：返回题目（剥离 correct_answer），供入群问卷渲染
CREATE OR REPLACE FUNCTION public.get_admission_questions(p_room_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_q jsonb;
  v_out jsonb;
  v_item jsonb;
  v_i int;
BEGIN
  SELECT admission_questionnaire::jsonb INTO v_q FROM chat_channel_settings WHERE room_id = p_room_id;
  IF v_q IS NULL OR jsonb_typeof(v_q) <> 'array' THEN
    RETURN '[]'::jsonb;
  END IF;
  v_out := '[]'::jsonb;
  FOR v_i IN 0 .. jsonb_array_length(v_q) - 1 LOOP
    v_item := v_q->v_i;
    v_out := v_out || jsonb_build_object(
      'index', v_i,
      'question', v_item->>'question',
      'type', v_item->>'type',
      'options', COALESCE(v_item->'options', '[]'::jsonb)
    );
  END LOOP;
  RETURN v_out;
END;
$$;

-- 5.3 get_admission_settings：管理员/房主读取完整设置（含密码/问卷），供准入管理面板
CREATE OR REPLACE FUNCTION public.get_admission_settings(p_room_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid text;
  v_settings chat_channel_settings%ROWTYPE;
BEGIN
  v_uid := app_user_id();
  IF v_uid IS NULL OR v_uid = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', '未登录');
  END IF;
  IF NOT (public.is_room_creator(p_room_id, v_uid)
          OR public.is_room_admin(p_room_id, v_uid)
          OR public.is_developer(v_uid)) THEN
    RETURN jsonb_build_object('ok', false, 'error', '无权限');
  END IF;
  SELECT * INTO v_settings FROM chat_channel_settings WHERE room_id = p_room_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', '设置不存在');
  END IF;
  RETURN jsonb_build_object('ok', true, 'settings', to_jsonb(v_settings));
END;
$$;

-- 5.4 redeem_invite：服务端原子兑换邀请码（校验 + used_count 原子递增）
CREATE OR REPLACE FUNCTION public.redeem_invite(p_invite_code text, p_room_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_inv channel_invites%ROWTYPE;
BEGIN
  SELECT * INTO v_inv FROM channel_invites
  WHERE invite_code = p_invite_code AND room_id = p_room_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', '邀请码无效');
  END IF;
  IF v_inv.expires_at IS NOT NULL AND v_inv.expires_at < now() THEN
    RETURN jsonb_build_object('ok', false, 'error', '邀请码已过期');
  END IF;
  IF v_inv.max_uses > 0 AND v_inv.used_count >= v_inv.max_uses THEN
    RETURN jsonb_build_object('ok', false, 'error', '邀请码已达使用上限');
  END IF;
  UPDATE channel_invites SET used_count = used_count + 1 WHERE id = v_inv.id;
  RETURN jsonb_build_object('ok', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.verify_admission(text, text, jsonb) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_admission_questions(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_admission_settings(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.redeem_invite(text, text) TO anon, authenticated;

-- ----------------------------------------------------------------------------
-- 6. 函数加固
-- ----------------------------------------------------------------------------
-- 6.1 sign_auth_jwt：HS256 遗留函数，禁止 anon/authenticated 调用（休眠地雷拆除），固定 search_path
REVOKE EXECUTE ON FUNCTION public.sign_auth_jwt(text) FROM anon, authenticated;
CREATE OR REPLACE FUNCTION public.sign_auth_jwt(p_user_id text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_secret TEXT;
  v_now BIGINT;
  v_payload JSONB;
  v_header JSONB;
  v_header_b64 TEXT;
  v_payload_b64 TEXT;
  v_signature TEXT;
BEGIN
  BEGIN
    v_secret := current_setting('config.jwt_secret', true);
  EXCEPTION WHEN OTHERS THEN
    v_secret := NULL;
  END;
  IF v_secret IS NULL OR v_secret = '' THEN
    RETURN NULL;
  END IF;
  v_now := EXTRACT(EPOCH FROM NOW())::BIGINT;
  v_header := jsonb_build_object('alg', 'HS256', 'typ', 'JWT');
  v_payload := jsonb_build_object(
    'iss', 'https://qwslopgbfkvnxrkqlvjl.supabase.co/auth/v1/',
    'sub', p_user_id,
    'aud', 'authenticated',
    'exp', v_now + 86400,
    'iat', v_now,
    'role', 'authenticated',
    'aal', 'aal1',
    'session_id', gen_random_uuid()::text,
    'is_anonymous', false
  );
  v_header_b64 := replace(replace(replace(encode(convert_to(v_header::text, 'UTF8'), 'base64'), E'\n', ''), '+', '-'), '/', '_');
  v_header_b64 := regexp_replace(v_header_b64, '=+$', '');
  v_payload_b64 := replace(replace(replace(encode(convert_to(v_payload::text, 'UTF8'), 'base64'), E'\n', ''), '+', '-'), '/', '_');
  v_payload_b64 := regexp_replace(v_payload_b64, '=+$', '');
  v_signature := replace(replace(replace(encode(hmac(v_header_b64 || '.' || v_payload_b64, v_secret, 'sha256'), 'base64'), E'\n', ''), '+', '-'), '/', '_');
  v_signature := regexp_replace(v_signature, '=+$', '');
  RETURN v_header_b64 || '.' || v_payload_b64 || '.' || v_signature;
END;
$$;

-- 6.2 increment_unread：触发器专用，禁止外部直接调用
REVOKE EXECUTE ON FUNCTION public.increment_unread() FROM anon, authenticated;

-- 注：app_user_id / current_d1_user_id 非 SECURITY DEFINER 且仅读取 GUC/会话上下文，
--     无 search_path 风险，保持线上原样，不做重写。

-- 6.3 cleanup_old_chat_messages：固定 search_path
CREATE OR REPLACE FUNCTION public.cleanup_old_chat_messages()
RETURNS TABLE(deleted_messages bigint, deleted_reactions bigint)
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  cutoff_ts bigint;
  msg_count bigint;
  react_count bigint;
BEGIN
  cutoff_ts := (EXTRACT(EPOCH FROM NOW() - INTERVAL '7 days') * 1000)::bigint;
  DELETE FROM chat_reactions
  WHERE NOT EXISTS (
    SELECT 1 FROM chat_messages
    WHERE chat_messages.event_id = chat_reactions.event_id
  );
  GET DIAGNOSTICS react_count = ROW_COUNT;
  DELETE FROM chat_messages
  WHERE ts < cutoff_ts;
  GET DIAGNOSTICS msg_count = ROW_COUNT;
  DELETE FROM chat_reactions
  WHERE NOT EXISTS (
    SELECT 1 FROM chat_messages
    WHERE chat_messages.event_id = chat_reactions.event_id
  );
  RETURN QUERY SELECT msg_count, react_count;
END;
$$;

-- ============================================================================
-- 完成。开发者白名单初始化：
--   INSERT INTO public.developers (user_id) VALUES ('<D1用户ID>');
--   （需管理员通过 SQL 控制台执行；service_role 亦可）
-- ============================================================================
