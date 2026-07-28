// 非 AI 工具代理 - 转发免费公共 API 请求
// GET /api/tools/proxy?tool_id=xxx&param1=...&param2=...

import { findTool } from './registry.js';

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}

export async function onRequestGet(context) {
  const { request } = context;
  const url = new URL(request.url);
  const toolId = url.searchParams.get('tool_id');

  if (!toolId) {
    return Response.json({ success: false, error: '缺少 tool_id 参数' }, { status: 400, headers: { 'Access-Control-Allow-Origin': '*' } });
  }

  const tool = findTool(toolId);
  if (!tool) {
    return Response.json({ success: false, error: '未知工具: ' + toolId }, { status: 400, headers: { 'Access-Control-Allow-Origin': '*' } });
  }

  if (tool.api_type !== 'proxy_get') {
    return Response.json({ success: false, error: '此工具不支持代理调用' }, { status: 400, headers: { 'Access-Control-Allow-Origin': '*' } });
  }

  try {
    // 收集参数（排除 tool_id 本身）
    const params = {};
    for (const [key, value] of url.searchParams.entries()) {
      if (key !== 'tool_id') params[key] = value;
    }

    // 合并默认参数
    const finalParams = { ...(tool.default_params || {}), ...params };

    // === 前处理：地理编码（天气工具）===
    if (tool.pre_process === 'geocode' && finalParams.city) {
      const geoRes = await fetchWithTimeout(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(finalParams.city)}&count=1&language=zh`,
        8000
      );
      const geoData = await geoRes.json();
      if (geoData.results && geoData.results.length > 0) {
        finalParams.latitude = geoData.results[0].latitude;
        finalParams.longitude = geoData.results[0].longitude;
        finalParams.timezone = geoData.results[0].timezone || 'auto';
        // 清理非 API 参数
        delete finalParams.city;
      } else {
        return Response.json({ success: false, error: '未找到城市: ' + finalParams.city }, { status: 404, headers: { 'Access-Control-Allow-Origin': '*' } });
      }
    }

    // 构建目标 URL
    let targetUrl;
    if (tool.url_template.includes('{')) {
      // 模板替换模式：url_template 中有 {param} 占位符
      targetUrl = tool.url_template;
      const matches = targetUrl.match(/\{(\w+)\}/g) || [];
      for (const match of matches) {
        const key = match.slice(1, -1);
        const val = finalParams[key] || '';
        targetUrl = targetUrl.replace(match, encodeURIComponent(val));
      }
      // 移除未替换的空参数
      targetUrl = targetUrl.replace(/\/\{[^}]+\}/g, '');
    } else {
      // 基础 URL + 查询参数模式
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(finalParams)) {
        if (value !== '' && value != null) query.set(key, value);
      }
      // 天气工具需要特殊参数
      if (toolId === 'weather') {
        query.set('current', 'temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m');
        query.set('daily', 'weather_code,temperature_2m_max,temperature_2m_min');
        query.set('forecast_days', '3');
      }
      targetUrl = tool.url_template + (query.toString() ? '?' + query.toString() : '');
    }

    // 发起请求
    const response = await fetchWithTimeout(targetUrl, 10000);

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      return Response.json(
        { success: false, error: `工具请求失败 (${response.status}): ${errText.slice(0, 200)}` },
        { status: 502, headers: { 'Access-Control-Allow-Origin': '*' } }
      );
    }

    // 判断响应类型
    const contentType = response.headers.get('Content-Type') || '';
    const respHeaders = new Headers({
      'Access-Control-Allow-Origin': '*'
    });

    if (contentType.includes('application/json')) {
      respHeaders.set('Content-Type', 'application/json');
      const data = await response.json();
      // 对于天气工具，附加城市名信息
      if (toolId === 'weather' && params.city) {
        data._city = params.city;
      }
      return new Response(JSON.stringify(data), { status: 200, headers: respHeaders });
    } else if (contentType.includes('image/') || contentType.includes('text/plain')) {
      respHeaders.set('Content-Type', contentType);
      const body = await response.arrayBuffer();
      return new Response(body, { status: 200, headers: respHeaders });
    } else {
      respHeaders.set('Content-Type', contentType || 'text/plain');
      const body = await response.text();
      return new Response(body, { status: 200, headers: respHeaders });
    }
  } catch (e) {
    if (e.name === 'AbortError') {
      return Response.json({ success: false, error: '工具请求超时（10秒）' }, { status: 504, headers: { 'Access-Control-Allow-Origin': '*' } });
    }
    return Response.json(
      { success: false, error: '代理请求失败: ' + (e.message || String(e)) },
      { status: 502, headers: { 'Access-Control-Allow-Origin': '*' } }
    );
  }
}

// 带超时的 fetch
function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timeoutId));
}
