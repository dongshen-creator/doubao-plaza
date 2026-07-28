// 工具注册表 - 所有可用工具的定义（唯一真实来源）
// GET /api/tools/registry — 返回所有工具定义

export const TOOL_REGISTRY = [
  // ===== AI 类工具（通过 /api/tools/ai 调用）=====
  {
    id: 'ai_chat',
    name: 'AI对话',
    icon: '🤖',
    category: 'independent',
    description: '与AI助手进行智能对话，支持多轮上下文',
    api_type: 'ai_chat',
    model: '@cf/zai-org/glm-4.7-flash',
    system_prompt: '你是逗包用户广场的AI助手。请用简洁友好的中文回答用户问题。如果用户用其他语言提问，也用中文回答，除非用户明确要求用其他语言。',
    input_fields: [
      { name: 'message', type: 'textarea', label: '消息内容', placeholder: '输入你的问题...', required: true }
    ],
    result_type: 'streaming_text',
    max_tokens: 512,
    supports_history: true
  },
  {
    id: 'ai_translate',
    name: 'AI翻译',
    icon: '🌐',
    category: 'independent',
    description: '多语言翻译，自动检测源语言',
    api_type: 'ai_chat',
    model: '@cf/meta/llama-3.2-1b-instruct',
    system_prompt: '你是一个翻译引擎。用户输入任意语言的文本，你将其翻译为中文。如果输入已是中文，则翻译为英文。只输出翻译结果，不添加任何解释或额外文字。',
    input_fields: [
      { name: 'text', type: 'textarea', label: '待翻译文本', placeholder: '输入要翻译的文本...', required: true }
    ],
    result_type: 'streaming_text',
    max_tokens: 512,
    supports_history: false
  },
  {
    id: 'ai_summarize',
    name: 'AI总结',
    icon: '📝',
    category: 'independent',
    description: '智能总结长文本的核心内容',
    api_type: 'ai_chat',
    model: '@cf/ibm-granite/granite-4.0-h-micro',
    system_prompt: '你是一个文本总结助手。请将用户提供的文本总结为简洁的要点，用中文输出。保留关键信息，去除冗余内容。如果文本已经是中文，直接总结；如果是其他语言，翻译并总结为中文。',
    input_fields: [
      { name: 'text', type: 'textarea', label: '待总结文本', placeholder: '粘贴需要总结的长文本...', required: true }
    ],
    result_type: 'streaming_text',
    max_tokens: 512,
    supports_history: false
  },
  {
    id: 'ai_draw',
    name: 'AI画图',
    icon: '🎨',
    category: 'independent',
    description: '根据文字描述生成图片',
    api_type: 'ai_image',
    model: '@cf/black-forest-labs/flux-1-schnell',
    system_prompt: null,
    input_fields: [
      { name: 'prompt', type: 'textarea', label: '图片描述', placeholder: '描述你想要生成的图片...', required: true }
    ],
    result_type: 'image',
    max_tokens: 0,
    supports_history: false
  },

  // ===== 免费 API 类工具（通过 /api/tools/proxy 调用）=====
  {
    id: 'weather',
    name: '天气查询',
    icon: '🌤️',
    category: 'independent',
    description: '查询任意城市的实时天气和预报',
    api_type: 'proxy_get',
    model: null,
    system_prompt: null,
    url_template: 'https://api.open-meteo.com/v1/forecast',
    default_params: {},
    input_fields: [
      { name: 'city', type: 'text', label: '城市名称', placeholder: '如：北京、Shanghai', required: true }
    ],
    result_type: 'weather_card',
    max_tokens: 0,
    supports_history: false,
    pre_process: 'geocode'
  },
  {
    id: 'qrcode',
    name: '二维码生成',
    icon: '📱',
    category: 'independent',
    description: '将文本或链接生成二维码图片',
    api_type: 'direct_url',
    model: null,
    system_prompt: null,
    url_template: 'https://api.qrserver.com/v1/create-qr-code/?size=300x300&data={data}',
    default_params: {},
    input_fields: [
      { name: 'data', type: 'textarea', label: '二维码内容', placeholder: '输入文本或链接...', required: true }
    ],
    result_type: 'image',
    max_tokens: 0,
    supports_history: false
  },
  {
    id: 'ip',
    name: 'IP查询',
    icon: '📍',
    category: 'independent',
    description: '查询IP地址的地理位置信息',
    api_type: 'proxy_get',
    model: null,
    system_prompt: null,
    url_template: 'https://ipwho.is/{ip}',
    default_params: {},
    input_fields: [
      { name: 'ip', type: 'text', label: 'IP地址', placeholder: '如：8.8.8.8（留空查询自己的IP）', required: false }
    ],
    result_type: 'json_card',
    max_tokens: 0,
    supports_history: false
  },
  {
    id: 'currency',
    name: '汇率查询',
    icon: '💱',
    category: 'independent',
    description: '查询最新货币汇率',
    api_type: 'proxy_get',
    model: null,
    system_prompt: null,
    url_template: 'https://api.frankfurter.dev/v2/rates?base={base}',
    default_params: { base: 'USD' },
    input_fields: [
      { name: 'base', type: 'select', label: '基准货币', required: true, default: 'USD', options: [
        { value: 'USD', label: 'USD - 美元' },
        { value: 'EUR', label: 'EUR - 欧元' },
        { value: 'CNY', label: 'CNY - 人民币' },
        { value: 'GBP', label: 'GBP - 英镑' },
        { value: 'JPY', label: 'JPY - 日元' },
        { value: 'KRW', label: 'KRW - 韩元' },
        { value: 'HKD', label: 'HKD - 港币' },
        { value: 'TWD', label: 'TWD - 台币' }
      ]}
    ],
    result_type: 'table',
    max_tokens: 0,
    supports_history: false
  },
  {
    id: 'joke',
    name: '随机笑话',
    icon: '😂',
    category: 'independent',
    description: '获取一个随机笑话',
    api_type: 'proxy_get',
    model: null,
    system_prompt: null,
    url_template: 'https://official-joke-api.appspot.com/random_joke',
    default_params: {},
    input_fields: [],
    result_type: 'text',
    max_tokens: 0,
    supports_history: false
  },
  {
    id: 'quote',
    name: '每日名言',
    icon: '💬',
    category: 'independent',
    description: '获取一条励志名言',
    api_type: 'proxy_get',
    model: null,
    system_prompt: null,
    url_template: 'https://zenquotes.io/api/random',
    default_params: {},
    input_fields: [],
    result_type: 'text',
    max_tokens: 0,
    supports_history: false
  },
  {
    id: 'avatar',
    name: '头像生成',
    icon: '🎭',
    category: 'independent',
    description: '根据文字生成随机风格头像',
    api_type: 'direct_url',
    model: null,
    system_prompt: null,
    url_template: 'https://api.dicebear.com/9.x/{style}/svg?seed={seed}',
    default_params: { style: 'avataaars' },
    input_fields: [
      { name: 'seed', type: 'text', label: '种子文字', placeholder: '任意文字（相同文字生成相同头像）', required: true },
      { name: 'style', type: 'select', label: '头像风格', required: true, default: 'avataaars', options: [
        { value: 'avataaars', label: '卡通人物' },
        { value: 'bottts', label: '机器人' },
        { value: 'identicon', label: '几何图案' },
        { value: 'lorelei', label: '插画风格' },
        { value: 'micah', label: '简约人物' },
        { value: 'adventurer', label: '冒险者' },
        { value: 'fun-emoji', label: '趣味表情' },
        { value: 'thumbs', label: '大拇指' }
      ]}
    ],
    result_type: 'image',
    max_tokens: 0,
    supports_history: false
  },
  {
    id: 'math',
    name: '数学计算',
    icon: '🔢',
    category: 'independent',
    description: '符号计算：求导、积分、因式分解等',
    api_type: 'proxy_get',
    model: null,
    system_prompt: null,
    url_template: 'https://newton.now.sh/api/v2/{operation}/{expression}',
    default_params: { operation: 'derive' },
    input_fields: [
      { name: 'expression', type: 'text', label: '数学表达式', placeholder: '如：x^2+2x', required: true },
      { name: 'operation', type: 'select', label: '运算类型', required: true, default: 'derive', options: [
        { value: 'derive', label: '求导' },
        { value: 'integrate', label: '积分' },
        { value: 'factor', label: '因式分解' },
        { value: 'simplify', label: '化简' },
        { value: 'zeroes', label: '求零点' },
        { value: 'tangent', label: '切线' },
        { value: 'area', label: '曲线下面积' },
        { value: 'cos', label: '余弦' },
        { value: 'sin', label: '正弦' },
        { value: 'tan', label: '正切' },
        { value: 'arccos', label: '反余弦' },
        { value: 'arcsin', label: '反正弦' },
        { value: 'arctan', label: '反正切' },
        { value: 'abs', label: '绝对值' },
        { value: 'log', label: '对数' },
        { value: 'expand', label: '展开' }
      ]}
    ],
    result_type: 'text',
    max_tokens: 0,
    supports_history: false
  }
];

// 根据 ID 查找工具
export function findTool(toolId) {
  return TOOL_REGISTRY.find(t => t.id === toolId);
}

export async function onRequestGet(context) {
  return Response.json({ success: true, data: TOOL_REGISTRY }, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/json'
    }
  });
}

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
