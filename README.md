# opencode-web — موقع محادثة مع نماذج OpenCode المجانية

موقع ويب بالعربية (RTL) بوضعين:

| الوضع | كيف يخدم | يحتاج الحاسوب ديالك؟ |
|---|---|---|
| 🔌 **عبر opencode** | كيوسّط للخدمة الخلفية ديال `opencode` المحلية (جلسات + أدوات + أذونات) | ✅ نعم |
| 🌐 **مباشر** | كيهدر مباشرة مع بوابة OpenCode المجانية بنفس طريقة عميل `opencode` | ❌ لا — كيخدم من أي سيرفر |

## 🚀 نشر بنقرة وحدة

<a href="https://render.com/deploy?repo=https://github.com/Sweetcoinss/opencode-web">
  <img src="https://render.com/images/deploy-to-render-button.svg" alt="Deploy to Render" height="36">
</a>

→ كيطلب منك غير **كلمة السر** (`APP_PASSWORD`) وكيعطيك رابط `https://<name>.onrender.com` كيخدم من التيليفون.

> GitHub Pages ما كيخدمش لهاد المشروع — حيت الموقع كيحتاج **سيرفر Node**
> (خاصو بروكسي: البوابة كتسمح للمتصفح غير بـ `GET`/`OPTIONS`، ماشي `POST`).

## 📱 رابط عمومي دابا، بلا حساب (Cloudflare Tunnel)

ملي الحاسوب شغّال، كتقدر تخرج رابط `https://….trycloudflare.com` كيخدم من الهاتف
ومن أي جهاز فالعالم — بلا تسجيل ولا بطاقة بنكية:

```cmd
tunnel.cmd        ← كليك مزدوج
```

السكريبت كيشغّل الخادم + النفق، وكيطبع الرابط وكيحفظو فـ `tunnel-url.txt`.

| | Cloudflare Tunnel | Render |
|---|---|---|
| حساب | ❌ لا | GitHub (مجاني) |
| كيخدم والحاسوب مسدود | ❌ لا | ✅ نعم |
| الرابط | كيتبدل ملي تعاود تشغّل | ثابت |

---

## 🔒 الحماية

الموقع فيه وضعين، والوضع **المحلي** كيدوز على خدمة OpenCode ديال الحاسوب
(كيقرا ملفات وكينفّذ أوامر). علاش فيها حماية تلقائية:

- **من برّا** (نفق / شبكة / نشر): الوضع المحلي **مسدود بـ `403`**، والمسارات
  الحقيقية ديال الحاسوب ما كترجعش فـ `/api/health` (كتبان «محجوب»).
- **من نفس الحاسوب**: الوضع المحلي خدام عادي.
- إلا حطيتي `APP_PASSWORD`: الوضع المحلي كيرجع متاح للطلبات المسجّلة الدخول.
- `DISABLE_LOCAL=1`: كيطفي الوضع المحلي نهائيًا (كيستعملو `render.yaml`).

بلا `APP_PASSWORD`، أي واحد عندو الرابط كيقدر يدردش بالنماذج المجانية — الله حافظ
إلا شاركتي الرابط بزاف. الدردشة بوحدها، ما كاينش وصول لملفات الحاسوب.

---

## 1) منين كتجي المجانية (نتيجة فحص الكود)

### أ) مفتاح عام، بلا تسجيل دخول

`opencode` ملي ما يلقاش أي اعتماد (credential) كيدخل لمسار عمومي:

```json
{ "providerID": "opencode", "settings": { "apiKey": "public" },
  "cost": [{ "input": 0, "output": 0 }] }
```

كيحيّد كل النماذج اللي `cost.input ≠ 0` وكيستعمل المفتاح الحرفي `"public"`،
اللي كيتبعت كـ `Authorization: Bearer public`. **ماشي تسجيل دخول.**

### ب) بوابة المجانية كتشيك على شكل الطلب

جرّبنا البوابة مباشرة، وهاذي هي النتيجة الميدانية:

| الطلب | النتيجة |
|---|---|
| `stream: true` + `tools` فيها **بالضبط** `read` و `bash` | ✅ 200 ويبثّ |
| بلا tools | ❌ 403 `FreeTierError: OpenCode's free tier can only be used from within OpenCode` |
| بلا stream | ❌ نفس الـ 403 |

والترويسات اللي كيصيفطها العميل الرسمي:```http
Authorization: Bearer public
User-Agent: opencode/<version>
x-opencode-client: cli
x-opencode-project: <project id>
x-opencode-session: ses_<12 hex><14 base62>
x-opencode-request: msg_<12 hex><14 base62>
```

ومعرفات `ses_`/`msg_` كتولّد هكذا (من كود OpenCode):

```
now = Date.now() * 0x1000 + counter
if (descending) now = ~now          // الجلسات descending، الرسائل ascending
hex(6 بايت من now) + 14 حرف عشوائي base62
```

هادشي اللي كيدير `direct.mjs` حرفيًا — **نفس الطريقة**، ماشي API جديد.

### ⚠️ بصراحة، المخاطر

- هادا **عميل غير رسمي**. البوابة كتشيك على "شكل" الطلب، وOpenCode يمكن
  يقوّي التشيك أو يحجب أي عميل آخر فأي وقت.
- كاينة **حصة مجانية محدودة**؛ ملي تسالي كترجع: `Free usage exceeded`,
  والمفتاح `public` ما كيتجاوزهاش.
- النماذج المجانية كتبدل وكتختفي بزاف.

---

## 2) التشغيل محليًا

**المتطلبات:** Node.js 18+ (بلا أي مكتبة خارجية).

```bash
cd C:\Users\RDP\opencode-web
node server.mjs
```

أو نقر مزدوج على `start.cmd`. ثم: <http://127.0.0.1:8790>

> الوضع 🌐 المباشر كيخدم حتى بلا `opencode` مثبّت أصلًا.
> الوضع 🔌 عبر opencode كيحتاج `opencode` مثبّت ومشغّل مرة على الأقل
> (`opencode service status` خاصو يطبع رابطًا).

## 3) النشر على سيرفر (باش يخدم من التيليفون)

الوضع المباشر ما كيحتاجش الحاسوب ديالك. على VPS مثلًا:

```bash
# 1. انسخ المجلد للسيرفر
scp -r opencode-web user@server:~/

# 2. شغّله مع كلمة سر (مهم، حيت الموقع غادي يولي عمومي)
cd ~/opencode-web
APP_PASSWORD='كلمة-سر-قوية' WEB_HOST=0.0.0.0 WEB_PORT=8790 node server.mjs
```

أو بـ `systemd`:

```ini
[Unit]
Description=opencode-web
After=network.target

[Service]
WorkingDirectory=/root/opencode-web
Environment=WEB_HOST=0.0.0.0
Environment=WEB_PORT=8790
Environment=APP_PASSWORD=كلمة-سر-قوية
Environment=WORKSPACE=/root/workspace
Environment=ENABLE_TOOLS=0
ExecStart=/usr/bin/node server.mjs
Restart=always

[Install]
WantedBy=multi-user.target
```

ثم من التيليفون: `http://<ip-السيرفر>:8790` (أو خلف Caddy/Nginx مع HTTPS).

### 🔐 الأمان

- **`APP_PASSWORD`**: كيحمي كل `/api/*` بكوكي HttpOnly. **إلزامي** إلا كان الموقع عمومي.
- **`ENABLE_TOOLS`**: بالافتراضي `0` — الموقع كيولي دردشة فقط، وما كيتنفذ والو على السيرفر. `1` كيفعّل الأدوات.
- الأدوات (`read`/`write`/`bash`) ملي كتفعّل كتنفّذ **على السيرفر اللي كيشغل الموقع**،
  ومحصورة داخل `WORKSPACE`. ما تخليش `ENABLE_TOOLS=1` على سيرفر عمومي
  إلا كنت فاهم المخاطر.
- ضع الخدمة خلف HTTPS (Caddy/Nginx) إلا خرجت للأنترنت.

---

## 4) وضع "دردشة فقط" (بلا أدوات)

بغيتي غير نماذج كتهدر لغويًا، بلا أي وصول للملفات؟ هادا هو الوضع الافتراضي دابا:

```bash
node server.mjs          # ENABLE_TOOLS غير مفعّل
```

- الواجهة كتوري «مباشر — دردشة فقط»، وما كتظهرش أي بطاقة أداة.
- الموديل كيتسيفط ليه برومبت محادثة عادي، وما كيتنفذ والو على السيرفر.

> ⚠️ **حقيقة خاصة:** حتى فهاد الوضع، خاص الطلب يمشي فيه `tools` فيها
> الأداتين بالضبط `read` و `bash`، حيت بوابة المجانية كترفض أي طلب بلايهم
> (`403 FreeTierError`). حنا كنصيفطوهم **غير كأسماء** باش نعديو البوابة،
> ولكن **عمرنا ما كننفذوهم** — علاش داكشي ماشي خطر.

باش ترجّع الأدوات: `ENABLE_TOOLS=1`.

## 5) متغيرات البيئة
| المتغير | الافتراضي | الوصف |
|---|---|---|
| `WEB_PORT` | `8790` | منفذ الموقع |
| `WEB_HOST` | `127.0.0.1` | `0.0.0.0` للوصول من الشبكة/التيليفون |
| `APP_PASSWORD` | — | كلمة سر لحماية `/api/*` |
| `OPENCODE_URL` | يُكتشف | عنوان خدمة opencode المحلية |
| `OPENCODE_PASSWORD` | من `~/.config/opencode/service.json` | كلمة سر الخدمة المحلية |
| `ENABLE_TOOLS` | `0` | `1` = فعّل `read/write/bash` (دردشة فقط بالافتراضي) |
| `DISABLE_LOCAL` | `0` | `1` = طفّي الوضع المحلي نهائيًا (للنشر العمومي) |
| `WORKSPACE` | مجلد التشغيل | جذر الأدوات في الوضع المباشر |
| `DIRECT_BASE_URL` | `https://opencode.ai/inference/v1` | بوابة النماذج المجانية |
| `DIRECT_VERSION` | من `opencode --version` | نسخة `User-Agent` |
| `DIRECT_SHOW_ALL` | `0` | `1` = أظهر حتى غير المجانية |
| `MAX_STEPS` | `8` | أقصى دورات أدوات لكل رسالة |
| `TOOL_TIMEOUT_MS` | `30000` | مهلة أمر `bash` |

## 6) الميزات

- **اختيار النموذج**: شاشة خاصة (من شريحة النموذج فوق، ولا ☰ ← اختيار النموذج) فيها
  بحث، فلتر (مجاني / الكل / المفضلة ★)، ونجمة للمفضلة. كتعرض الاسم، المعرّف،
  والوسوم (مجاني، أدوات، تفكير، صور، حجم السياق).
- **واجهة على نمط تطبيق موبايل**: شريط علوي (قائمة + شريحة النموذج)، شاشة ترحيب
  بتدرّج لوني + 4 اختصارات، فقاعة إدخال دائرية، قائمة جانبية منزلقة، وشاشة إعدادات.
- **مظهر فاتح / غامق / حسب النظام** — بزر فالشريط العلوي أو من الإعدادات.
- بثّ مباشر للإجابة + سلسلة التفكير (reasoning).
- بطاقات استدعاءات الأدوات (`read` / `write` / `bash`) مع المخرجات وزر الإيقاف.
- الوضع المحلي: جلسات، أذونات، عملاء (`build`/`plan`)، مجلد عمل.
- الوضع المباشر: محادثات محفوظة فالمتصفح، بلا أي حساب ولا خدمة محلية.
- إدخال صوتي (بالمتصفح، إلا كان مدعومًا)، نسخ الجواب، وإعادة التوليد.
- عرض الرموز والتكلفة (0$).

## 7) البنية

```
opencode-web/
├── server.mjs          خادم HTTP بلا مكتبات: يكتشف الخدمة ويوسّط الطلبات
├── direct.mjs          عميل البوابة المجانية: الترويسات + المعرّفات + الأدوات
├── public/
│   ├── index.html      الواجهة (عربي RTL، نمط تطبيق موبايل)
│   ├── style.css       المظهرين (فاتح/غامق) والتخطيط
│   └── app.js          منطق الوضعين
├── start.cmd           تشغيل بنقرة مزدوجة
├── tunnel.cmd          رابط عمومي للموقع (Cloudflare Tunnel)
├── tunnel.ps1          السكريبت ديال النفق
├── Dockerfile          للنشر على أي منصة (Render / Railway / Fly / VPS)
├── render.yaml         نشر بنقرة وحدة على Render
├── .github/workflows/  فحص أوتوماتيكي (CI)
├── test-flow.mjs       اختبار الوضع المحلي (بثّ + أدوات + تكلفة)
├── test-api.mjs        اختبار جلسات/نموذج/إيقاف/أذونات
├── test-direct.mjs     اختبار الوضع المباشر (بوابة + أدوات)
├── test-gateway.mjs    يبيّن شنو كتقبل البوابة وشنو كترفض
├── test-chatonly.mjs   اختبار وضع الدردشة فقط
├── check-all.mjs       فحص شامل (واجهة + وضعين)
├── test-login.mjs      اختبار كلمة السر
└── README.md
```

### نقاط النهاية

| المسار | الوصف |
|---|---|
| `GET /api/health` | حالة الاتصال + معلومات الوضع المباشر |
| `GET /api/models` | نماذج خدمة opencode المحلية |
| `GET /api/agents` | الوكلاء |
| `GET /api/sessions` · `POST /api/sessions` | قائمة/إنشاء جلسة |
| `GET /api/sessions/:id/messages` | رسائل الجلسة |
| `POST /api/sessions/:id/prompt` · `/interrupt` · `/model` | إرسال / إيقاف / تغيير النموذج |
| `GET /api/sessions/:id/permissions` | الأذونات |
| `GET /api/events` | بثّ SSE لأحداث opencode |
| `GET /api/direct/status` | حالة بوابة المجانية |
| `GET /api/direct/models` | النماذج المجانية من البوابة |
| `POST /api/direct/chat` | محادثة مباشرة (SSE، مع حلقة أدوات) |
| `POST /api/login` | تسجيل الدخول بكلمة السر |

## 8) الاختبار

```bash
node test-flow.mjs     # الوضع المحلي
node test-api.mjs      # جلسات + أذونات
node test-direct.mjs   # البوابة المجانية + الأدوات
node test-chatonly.mjs # دردشة فقط (بلا أدوات)
node check-all.mjs     # فحص شامل: الواجهة + الوضعين
node test-gateway.mjs  # شنو كتقبل البوابة (تحقق ميداني)
WEB=http://127.0.0.1:8791 node test-login.mjs   # كلمة السر (مع APP_PASSWORD)
```
