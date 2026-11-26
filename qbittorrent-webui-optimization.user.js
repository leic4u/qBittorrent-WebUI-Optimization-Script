// ==UserScript==
// @name         qBittorrent WebUI 优化脚本（Tracker 批量管理 + Peer 归属地/运营商）
// @namespace    https://github.com/leic4u/qBittorrent-WebUI-Optimization-Script
// @version      1.1.4
// @description  为 qBittorrent 官方 WebUI 提供批量 Tracker 管理，并在 Peer 列表显示归属地和运营商；IP 查询结果带缓存与多接口回退。
// @author       leic4u
// @license      GPL-3.0-or-later
// @homepage     https://github.com/leic4u/qBittorrent-WebUI-Optimization-Script
// @include      /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\/.*$/
// @include      /^https?:\/\/(192\.168|10\.\d+|172\.(1[6-9]|2\d|3[01]))\.\d+\.\d+(:\d+)?\/.*$/
// @include      /^https?:\/\/qb\.[^/]+(:\d+)?\/.*$/
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @sandbox      raw
// @connect      opendata.baidu.com
// @connect      ipwho.is
// @connect      api.ip.sb
// @connect      ipapi.co
// @connect      api.db-ip.com
// @connect      ipinfo.io
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // 在 Tampermonkey 的 raw 沙箱中脚本运行于页面主世界；保留 unsafeWindow 兜底。
    // qBittorrent 的 DynamicTable 必须在页面上下文中 patch，否则页面脚本看不到修改。
    const PAGE = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

    // 模块开关的持久化键。优先用用户脚本管理器的存储，失败时回退到本地存储。
    const TOGGLE_KEYS = {
        tracker: 'qbt-opt-enable-tracker',
        peer: 'qbt-opt-enable-peer'
    };

    function readToggle(key, fallback) {
        try {
            if (typeof GM_getValue === 'function') {
                const value = GM_getValue(key, undefined);
                if (typeof value === 'boolean') return value;
            }
        } catch (_) {
            // 管理器存储不可用时回退
        }
        try {
            const raw = localStorage.getItem(key);
            if (raw === '1' || raw === '0') return raw === '1';
        } catch (_) {
            // 本地存储不可用时用默认值
        }
        return fallback;
    }

    function writeToggle(key, value) {
        try {
            if (typeof GM_setValue === 'function') GM_setValue(key, value);
        } catch (_) {
            // 忽略：下方仍会写入本地存储兜底
        }
        try {
            localStorage.setItem(key, value ? '1' : '0');
        } catch (_) {
            // 忽略：存储不可用时本次会话仍按读取到的值运行
        }
    }

    const CONFIG = {
        version: '1.1.4',

        // 初始值来自持久化开关；运行时可通过管理器下拉菜单切换，切换后刷新生效。
        enableTrackerTool: readToggle(TOGGLE_KEYS.tracker, true),
        enablePeerInfo: readToggle(TOGGLE_KEYS.peer, true),

        // 缓存与列顺序键名独立命名，避免与旧脚本互相污染。
        cacheKey: 'qbt-webui-optimization-ip-cache-v1',
        orderMigrationKey: 'qbt-webui-optimization-column-order-v1',
        successTTL: 30 * 24 * 60 * 60 * 1000,
        failureTTL: 10 * 60 * 1000,
        requestTimeout: 8000,
        concurrency: 3,
        requestInterval: 300,

        geoColumn: { name: 'qbt_geo_location', title: '归属地', width: 130 },
        ispColumn: { name: 'qbt_isp', title: '运营商', width: 130 },
        showCity: true,
        loadingText: '查询中…',
        failedText: '查询失败',
        unknownText: '未知',
        privateText: '内网',
        noIspText: '—'
    };

    console.info(`[QBT Opt] v${CONFIG.version} userscript started; pageWindow=${PAGE === window ? 'same' : 'unsafeWindow'}`);

    /* =====================================================================
     * 一、IP 归属地 / 运营商模块
     * ===================================================================== */

    // ---------- 名称标准化 ----------
    const REGION_MAP = new Map([
        ['Beijing', '北京市'], ['Shanghai', '上海市'], ['Tianjin', '天津市'], ['Chongqing', '重庆市'],
        ['Anhui', '安徽省'], ['Fujian', '福建省'], ['Gansu', '甘肃省'], ['Guangdong', '广东省'],
        ['Guizhou', '贵州省'], ['Hainan', '海南省'], ['Hebei', '河北省'], ['Heilongjiang', '黑龙江省'],
        ['Henan', '河南省'], ['Hubei', '湖北省'], ['Hunan', '湖南省'], ['Jiangsu', '江苏省'],
        ['Jiangxi', '江西省'], ['Jilin', '吉林省'], ['Liaoning', '辽宁省'], ['Qinghai', '青海省'],
        ['Shaanxi', '陕西省'], ['Shandong', '山东省'], ['Shanxi', '山西省'], ['Sichuan', '四川省'],
        ['Yunnan', '云南省'], ['Zhejiang', '浙江省'], ['Guangxi', '广西壮族自治区'],
        ['Inner Mongolia', '内蒙古自治区'], ['Ningxia', '宁夏回族自治区'], ['Xinjiang', '新疆维吾尔自治区'],
        ['Tibet', '西藏自治区'], ['Hong Kong', '中国香港'], ['Macao', '中国澳门'], ['Macau', '中国澳门'],
        ['Beijing Municipality', '北京市'], ['Shanghai Municipality', '上海市'],
        ['Tianjin Municipality', '天津市'], ['Chongqing Municipality', '重庆市'],
        ['Sichuan Province', '四川省'], ['Guangdong Province', '广东省'], ['Jiangsu Province', '江苏省'],
        ['Zhejiang Province', '浙江省'], ['Shandong Province', '山东省'], ['Hubei Province', '湖北省'],
        ['Hunan Province', '湖南省'], ['Fujian Province', '福建省'], ['Anhui Province', '安徽省'],
        ['Jiangxi Province', '江西省'], ['Henan Province', '河南省'], ['Hebei Province', '河北省'],
        ['Shanxi Province', '山西省'], ['Shaanxi Province', '陕西省'], ['Liaoning Province', '辽宁省'],
        ['Jilin Province', '吉林省'], ['Heilongjiang Province', '黑龙江省'], ['Yunnan Province', '云南省'],
        ['Guizhou Province', '贵州省'], ['Gansu Province', '甘肃省'], ['Qinghai Province', '青海省'],
        ['Hainan Province', '海南省'],
        ['Inner Mongolia Autonomous Region', '内蒙古自治区'],
        ['Guangxi Zhuang Autonomous Region', '广西壮族自治区'],
        ['Ningxia Hui Autonomous Region', '宁夏回族自治区'],
        ['Xinjiang Uyghur Autonomous Region', '新疆维吾尔自治区'],
        ['Tibet Autonomous Region', '西藏自治区']
    ]);

    const CHINA_REGIONS = [
        '内蒙古自治区', '广西壮族自治区', '宁夏回族自治区', '新疆维吾尔自治区', '西藏自治区',
        '黑龙江省', '吉林省', '辽宁省', '河北省', '山西省', '陕西省', '甘肃省', '青海省',
        '山东省', '河南省', '江苏省', '安徽省', '浙江省', '湖北省', '湖南省', '江西省',
        '福建省', '广东省', '海南省', '四川省', '贵州省', '云南省',
        '北京市', '天津市', '上海市', '重庆市', '中国香港', '中国澳门', '香港', '澳门'
    ];

    const REGION_SHORT_MAP = [
        ['内蒙古', '内蒙古自治区'], ['广西', '广西壮族自治区'], ['宁夏', '宁夏回族自治区'],
        ['新疆', '新疆维吾尔自治区'], ['西藏', '西藏自治区'], ['黑龙江', '黑龙江省'],
        ['吉林', '吉林省'], ['辽宁', '辽宁省'], ['河北', '河北省'], ['山西', '山西省'],
        ['陕西', '陕西省'], ['甘肃', '甘肃省'], ['青海', '青海省'], ['山东', '山东省'],
        ['河南', '河南省'], ['江苏', '江苏省'], ['安徽', '安徽省'], ['浙江', '浙江省'],
        ['湖北', '湖北省'], ['湖南', '湖南省'], ['江西', '江西省'], ['福建', '福建省'],
        ['广东', '广东省'], ['海南', '海南省'], ['四川', '四川省'], ['贵州', '贵州省'],
        ['云南', '云南省'], ['北京', '北京市'], ['天津', '天津市'], ['上海', '上海市'],
        ['重庆', '重庆市'], ['香港', '中国香港'], ['澳门', '中国澳门']
    ];

    // 百度接口的 location 形如「广东省深圳市 中国电信」，把运营商后缀单独提取出来。
    const ISP_SUFFIX = /(?:\s+|,|，)*(中国电信|中国移动|中国联通|中国广电|教育网|科技网|China Telecom|China Mobile|China Unicom|CHINANET|CMNET|CERNET).*$/i;

    const ISP_RULES = [
        [/(中国电信|China Telecom|CHINANET)/i, '中国电信'],
        [/(中国联通|China Unicom|UNICOM)/i, '中国联通'],
        [/(中国移动|China Mobile|CMNET)/i, '中国移动'],
        [/(中国广电|China Broadnet)/i, '中国广电'],
        [/(教育网|CERNET)/i, '教育网'],
        [/(科技网|CSTNET)/i, '科技网'],
        [/中国铁通/, '中国铁通']
    ];

    function normalizeISP(raw) {
        const value = String(raw || '').replace(/^AS\d+\s*/i, '').trim();
        if (!value) return '';
        for (const [pattern, label] of ISP_RULES) {
            if (pattern.test(value)) return label;
        }
        return value.length > 40 ? `${value.slice(0, 40)}…` : value;
    }

    function parseChineseLocation(location) {
        const raw = String(location || '').trim();
        const match = raw.match(ISP_SUFFIX);
        const isp = normalizeISP(match ? match[1] : '');
        const clean = raw.replace(ISP_SUFFIX, '').trim();
        let region = '';
        let city = '';

        for (const candidate of CHINA_REGIONS) {
            if (clean.startsWith(candidate)) {
                region = candidate;
                city = clean.slice(candidate.length).replace(/^[\s,，-]+/, '').trim();
                break;
            }
        }

        if (!region) {
            for (const [prefix, normalized] of REGION_SHORT_MAP) {
                if (clean.startsWith(prefix)) {
                    region = normalized;
                    city = clean.slice(prefix.length).replace(/^[\s,，-]+/, '').trim();
                    break;
                }
            }
        }

        city = city.replace(/\s+(省|市|区|县|州)$/, '').trim();
        if (region && city === region.replace(/(省|市|自治区|特别行政区)$/, '')) city = '';
        return { region, city, isp };
    }

    function normalizeRegion(region) {
        const value = String(region || '').trim();
        if (!value) return '';
        if (REGION_MAP.has(value)) return REGION_MAP.get(value);
        const simplified = value.replace(/\s+(Province|State|Autonomous Region|Municipality|Sheng)$/i, '').trim();
        return REGION_MAP.get(simplified) || value;
    }

    // ---------- IP 判断 ----------
    function isIPv4(ip) {
        if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) return false;
        return ip.split('.').every(part => Number(part) >= 0 && Number(part) <= 255);
    }

    function isIPv6(ip) {
        return /^[0-9a-fA-F:]+$/.test(ip) && ip.includes(':');
    }

    function isPrivateIP(ip) {
        const value = String(ip || '').trim();
        if (isIPv4(value)) {
            const [a, b] = value.split('.').map(Number);
            return a === 0 || a === 10 || a === 127 ||
                (a === 169 && b === 254) ||
                (a === 172 && b >= 16 && b <= 31) ||
                (a === 192 && b === 168) ||
                (a === 100 && b >= 64 && b <= 127);
        }
        if (isIPv6(value)) {
            const lower = value.toLowerCase();
            if (lower === '::1' || /^(fc|fd)/.test(lower) || /^fe[89ab]/.test(lower)) return true;
            if (lower.startsWith('::ffff:')) {
                const embedded = lower.slice(7);
                return isIPv4(embedded) && isPrivateIP(embedded);
            }
        }
        return false;
    }

    // ---------- 结果格式化 ----------
    function normalizeLocation(raw) {
        const country = String(raw?.country || '').trim();
        const countryCode = String(raw?.countryCode || '').trim().toUpperCase();
        const region = normalizeRegion(raw?.region);
        const city = String(raw?.city || '').trim();
        const isp = normalizeISP(raw?.isp);
        const isChina = countryCode === 'CN' || country === 'China' || country === '中国';

        let locationDisplay = CONFIG.unknownText;
        if (isChina) {
            locationDisplay = region || city || '中国';
        } else {
            locationDisplay = region || city || country || CONFIG.unknownText;
        }
        if (CONFIG.showCity && region && city && city !== region && !locationDisplay.includes(city)) {
            locationDisplay += ` · ${city}`;
        }
        return { country, countryCode, region, city, isp, locationDisplay };
    }

    function mergeResults(base, extra) {
        return normalizeLocation({
            country: base?.country || extra.country,
            countryCode: base?.countryCode || extra.countryCode,
            region: base?.region || extra.region,
            city: base?.city || extra.city,
            isp: base?.isp || extra.isp
        });
    }

    // ---------- GeoIP 数据源（按优先级回退） ----------
    const PROVIDERS = [
        {
            name: 'Baidu',
            ipv4Only: true,
            url(ip) {
                return `https://opendata.baidu.com/api.php?co=&resource_id=6006&oe=utf8&query=${encodeURIComponent(ip)}`;
            },
            parse(data) {
                if (!data || String(data.status) !== '0' || !Array.isArray(data.data) || !data.data[0]) return null;
                const location = String(data.data[0].location || '').trim();
                if (!location) return null;
                const parsed = parseChineseLocation(location);
                if (!parsed.region && !parsed.city) return null;
                return { country: '中国', countryCode: 'CN', region: parsed.region, city: parsed.city, isp: parsed.isp };
            }
        },
        {
            name: 'IPWho',
            url(ip) {
                return `https://ipwho.is/${encodeURIComponent(ip)}`;
            },
            parse(data) {
                if (!data || data.success === false) return null;
                const result = {
                    country: data.country,
                    countryCode: data.country_code,
                    region: data.region,
                    city: data.city,
                    isp: data.connection?.isp || data.connection?.org || ''
                };
                if (!result.country && !result.region && !result.isp) return null;
                return result;
            }
        },
        {
            name: 'IP.SB',
            url(ip) {
                return `https://api.ip.sb/geoip/${encodeURIComponent(ip)}`;
            },
            parse(data) {
                if (!data || !data.country) return null;
                return {
                    country: data.country,
                    countryCode: data.country_code,
                    region: data.region,
                    city: data.city,
                    isp: data.isp || data.organization || ''
                };
            }
        },
        {
            name: 'IPAPI',
            url(ip) {
                return `https://ipapi.co/${encodeURIComponent(ip)}/json/`;
            },
            parse(data) {
                if (!data || !data.country_name) return null;
                return {
                    country: data.country_name,
                    countryCode: data.country_code,
                    region: data.region,
                    city: data.city,
                    isp: data.org || ''
                };
            }
        },
        {
            name: 'IPInfo',
            url(ip) {
                return `https://ipinfo.io/${encodeURIComponent(ip)}/json`;
            },
            parse(data) {
                if (!data || !data.country) return null;
                return {
                    country: data.country,
                    countryCode: data.country,
                    region: data.region,
                    city: data.city,
                    isp: data.org || ''
                };
            }
        },
        {
            name: 'DB-IP',
            url(ip) {
                return `https://api.db-ip.com/v2/free/${encodeURIComponent(ip)}`;
            },
            parse(data) {
                if (!data || !data.countryName) return null;
                return {
                    country: data.countryName,
                    countryCode: data.countryCode,
                    region: data.stateProv,
                    city: data.city,
                    isp: ''
                };
            }
        }
    ];

    // ---------- 缓存 ----------
    let cache = {};
    try {
        cache = JSON.parse(localStorage.getItem(CONFIG.cacheKey) || '{}') || {};
    } catch (_) {
        cache = {};
    }

    function saveCache() {
        try {
            localStorage.setItem(CONFIG.cacheKey, JSON.stringify(cache));
        } catch (error) {
            console.warn('[QBT Opt] cache save failed:', error);
        }
    }

    function getCache(ip) {
        const item = cache[ip];
        if (!item) return null;
        const ttl = item.ok ? CONFIG.successTTL : CONFIG.failureTTL;
        if (!item.timestamp || Date.now() - item.timestamp > ttl) {
            delete cache[ip];
            return null;
        }
        return item.data || null;
    }

    function setCache(ip, data, ok) {
        cache[ip] = { timestamp: Date.now(), ok: Boolean(ok), data };
        saveCache();
    }

    // ---------- 查询队列 ----------
    const pending = new Map();
    const queue = [];
    const providerCooldown = new Map();
    let active = 0;
    let lastStart = 0;
    let queueTimer = null;

    function requestJSON(url, providerName) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                timeout: CONFIG.requestTimeout,
                headers: {
                    Accept: 'application/json,text/plain,*/*',
                    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.7'
                },
                onload(response) {
                    if (response.status < 200 || response.status >= 300) {
                        const error = new Error(`${providerName}: HTTP ${response.status}`);
                        error.status = response.status;
                        reject(error);
                        return;
                    }
                    try {
                        resolve(JSON.parse(response.responseText));
                    } catch (_) {
                        reject(new Error(`${providerName}: JSON parse error`));
                    }
                },
                onerror() { reject(new Error(`${providerName}: network error`)); },
                ontimeout() { reject(new Error(`${providerName}: timeout`)); }
            });
        });
    }

    async function queryIP(ip) {
        const cached = getCache(ip);
        if (cached) return cached;

        if (isPrivateIP(ip)) {
            const result = normalizeLocation({});
            result.locationDisplay = CONFIG.privateText;
            setCache(ip, result, true);
            return result;
        }

        if (pending.has(ip)) return pending.get(ip);

        const promise = (async () => {
            let result = null;
            let providerName = '';

            for (const provider of PROVIDERS) {
                if (provider.ipv4Only && !isIPv4(ip)) continue;
                if (Date.now() < (providerCooldown.get(provider.name) || 0)) continue;

                try {
                    const data = await requestJSON(provider.url(ip), provider.name);
                    const parsed = provider.parse(data);
                    if (!parsed || (!parsed.country && !parsed.region && !parsed.city && !parsed.isp)) {
                        throw new Error(`${provider.name}: unusable result`);
                    }
                    result = result ? mergeResults(result, parsed) : normalizeLocation(parsed);
                    providerName = provider.name;

                    // 归属地和运营商都拿到时才停止，否则继续找下一个数据源补充。
                    if (result.isp && (result.region || result.city || result.country)) break;
                } catch (error) {
                    if (error?.status === 429) {
                        providerCooldown.set(provider.name, Date.now() + 60_000);
                    }
                    console.debug(`[QBT Opt] ${ip} ${error.message}`);
                }
            }

            if (!result) {
                result = normalizeLocation({});
                result.locationDisplay = CONFIG.failedText;
                setCache(ip, result, false);
                console.warn(`[QBT Opt] all providers failed for ${ip}`);
                return result;
            }

            result.provider = providerName;
            setCache(ip, result, true);
            console.info(`[QBT Opt] ${ip} -> ${result.locationDisplay} / ${result.isp || CONFIG.noIspText} (${providerName})`);
            return result;
        })();

        pending.set(ip, promise);
        try {
            return await promise;
        } finally {
            pending.delete(ip);
        }
    }

    function enqueue(ip) {
        if (!ip || getCache(ip) || pending.has(ip)) return;
        if (queue.some(item => item.ip === ip)) return;
        queue.push({ ip });
        processQueue();
    }

    function processQueue() {
        if (queueTimer || active >= CONFIG.concurrency || queue.length === 0) return;
        const wait = Math.max(0, CONFIG.requestInterval - (Date.now() - lastStart));
        if (wait > 0) {
            queueTimer = setTimeout(() => {
                queueTimer = null;
                processQueue();
            }, wait);
            return;
        }

        const task = queue.shift();
        active++;
        lastStart = Date.now();
        queryIP(task.ip)
            .catch(() => null)
            .then(result => {
                if (result) refreshPeerColumns();
            })
            .finally(() => {
                active--;
                processQueue();
            });
        processQueue();
    }

    // ---------- qBittorrent DynamicTable 原生列接入 ----------
    let peerTable = null;

    function refreshPeerColumns() {
        const table = peerTable;
        if (!table) return;
        [CONFIG.geoColumn.name, CONFIG.ispColumn.name].forEach(name => {
            if (!table.columns?.[name]) return;
            try {
                table.updateColumn(name, true);
            } catch (error) {
                console.debug('[QBT Opt] refresh failed:', error);
            }
        });
    }

    function moveColumnsAfterIP(table) {
        const names = [CONFIG.geoColumn.name, CONFIG.ispColumn.name];
        const ipIndex = table.columns?.findIndex(column => column?.name === 'ip') ?? -1;
        if (ipIndex < 0) return;

        // 先连同 colgroup / 表头的节点一起摘除，再按目标位置插回，保证三处顺序一致。
        const moved = names.map(name => {
            const index = table.columns.findIndex(column => column?.name === name);
            if (index < 0) return null;
            const column = table.columns[index];
            const col = table.colgroup?.children[index];
            const th = table.fixedTableHeader?.children[index];
            table.columns.splice(index, 1);
            if (col) col.remove();
            if (th) th.remove();
            return { column, col, th };
        }).filter(Boolean);

        const newIpIndex = table.columns.findIndex(column => column?.name === 'ip');
        if (newIpIndex < 0) return;

        moved.forEach(({ column, col, th }, offset) => {
            const target = newIpIndex + 1 + offset;
            table.columns.splice(target, 0, column);
            const refCol = table.colgroup?.children[target];
            const refTh = table.fixedTableHeader?.children[target];
            if (col) {
                if (refCol) refCol.before(col);
                else table.colgroup?.append(col);
            }
            if (th) {
                if (refTh) refTh.before(th);
                else table.fixedTableHeader?.append(th);
            }
        });
    }

    function makeUpdateTd(kind) {
        return function (td, row) {
            const ip = String(row?.full_data?.ip || '').trim();
            if (!ip) {
                td.textContent = CONFIG.unknownText;
                td.title = '';
                return;
            }

            const cached = getCache(ip);
            if (cached) {
                const text = kind === 'geo'
                    ? (cached.locationDisplay || CONFIG.unknownText)
                    : (cached.isp || CONFIG.noIspText);
                td.textContent = text;
                td.title = `${kind === 'geo' ? '归属地' : '运营商'}：${text}\nIP：${ip}\n数据源：${cached.provider || '本地缓存'}`;
                return;
            }

            td.textContent = CONFIG.loadingText;
            td.title = `IP：${ip}`;
            enqueue(ip);
        };
    }

    function addPeerColumns(table) {
        [
            { config: CONFIG.geoColumn, kind: 'geo' },
            { config: CONFIG.ispColumn, kind: 'isp' }
        ].forEach(({ config, kind }) => {
            if (table.columns[config.name]) return;
            table.newColumn(config.name, '', config.title, config.width, true);
            const column = table.columns[config.name];
            if (!column) return;
            column.dataProperties = ['ip'];
            column.calculateBuffer = () => 8;
            column.updateTd = makeUpdateTd(kind);
        });
    }

    function patchTorrentPeersTable(DynamicTable) {
        if (!DynamicTable || typeof DynamicTable.TorrentPeersTable !== 'function') return false;

        const Ctor = DynamicTable.TorrentPeersTable;
        if (Ctor.__QBT_OPT_PATCHED__) return true;

        const proto = Ctor.prototype;
        if (!proto || typeof proto.initColumns !== 'function') return false;

        const originalInitColumns = proto.initColumns;
        proto.initColumns = function () {
            originalInitColumns.call(this);
            addPeerColumns(this);

            peerTable = this;
            PAGE.__QBT_OPT_PEER_TABLE__ = this;
            moveColumnsAfterIP(this);

            // 首次安装时保存正确列序，之后尊重用户在 WebUI 中拖动调整的顺序。
            if (localStorage.getItem(CONFIG.orderMigrationKey) !== '1') {
                try {
                    this.saveColumnsOrder();
                    localStorage.setItem(CONFIG.orderMigrationKey, '1');
                } catch (_) {
                    // ignore
                }
            }
        };

        const originalLoadColumnsOrder = proto.loadColumnsOrder;
        proto.loadColumnsOrder = function () {
            originalLoadColumnsOrder.call(this);
            const hasNewColumns = [CONFIG.geoColumn.name, CONFIG.ispColumn.name]
                .every(name => Array.isArray(this.columns) && this.columns.some(column => column?.name === name));
            if (hasNewColumns && localStorage.getItem(CONFIG.orderMigrationKey) !== '1') {
                moveColumnsAfterIP(this);
            }
        };

        Object.defineProperty(Ctor, '__QBT_OPT_PATCHED__', {
            value: true,
            configurable: false,
            enumerable: false,
            writable: false
        });

        console.info('[QBT Opt] TorrentPeersTable patched successfully');
        return true;
    }

    function tryPatchPeerTable() {
        try {
            return patchTorrentPeersTable(PAGE.qBittorrent?.DynamicTable);
        } catch (error) {
            console.debug('[QBT Opt] patch attempt failed:', error);
            return false;
        }
    }

    function installPeerInfoModule() {
        // dynamicTable.js 可能晚于脚本执行，用属性拦截器捕获 `DynamicTable ??= ...` 赋值。
        let dynamicTableValue;
        try {
            const qbt = PAGE.qBittorrent || (PAGE.qBittorrent = {});
            const descriptor = Object.getOwnPropertyDescriptor(qbt, 'DynamicTable');
            dynamicTableValue = qbt.DynamicTable;
            tryPatchPeerTable();

            if (!descriptor || descriptor.configurable) {
                Object.defineProperty(qbt, 'DynamicTable', {
                    configurable: true,
                    enumerable: true,
                    get() { return dynamicTableValue; },
                    set(value) {
                        dynamicTableValue = value;
                        patchTorrentPeersTable(value);
                    }
                });
                if (dynamicTableValue) patchTorrentPeersTable(dynamicTableValue);
                console.info('[QBT Opt] page-context DynamicTable hook installed');
            } else {
                console.warn('[QBT Opt] DynamicTable property is not configurable; fallback polling enabled');
            }
        } catch (error) {
            console.warn('[QBT Opt] failed to install page-context hook:', error);
        }

        // 兜底轮询：防止扩展或浏览器阻止 accessor 修改。
        let attempts = 0;
        const timer = setInterval(() => {
            attempts++;
            if (tryPatchPeerTable()) {
                clearInterval(timer);
                return;
            }
            if (attempts >= 1000) clearInterval(timer);
        }, 10);
    }

    /* =====================================================================
     * 二、Tracker 批量管理模块
     * ===================================================================== */

    const TrackerTool = (() => {
        const apiBase = new URL('api/v2/', location.href).href;
        const urlPattern = /^(?:udp|https?):\/\//i;
        let webApiVersion = '';
        let running = false;

        const ACTIONS = {
            replace: {
                title: '完整替换',
                fields: [
                    { name: 'origUrl', label: '旧 Tracker（完整地址）' },
                    { name: 'newUrl', label: '新 Tracker（完整地址）' }
                ]
            },
            keywordReplace: {
                title: '关键字替换',
                fields: [
                    { name: 'origUrl', label: '旧关键字' },
                    { name: 'newUrl', label: '新关键字', wholeLabel: '新 Tracker（完整地址）' }
                ],
                checkbox: {
                    name: 'replaceWhole',
                    label: '关键字命中时，使用新 Tracker 替换整条旧 Tracker'
                }
            },
            add: {
                title: '添加',
                fields: [{ name: 'trackerUrl', label: 'Tracker 地址（多个用 | 分隔）' }]
            },
            remove: {
                title: '删除',
                fields: [{ name: 'trackerUrl', label: '要删除的 Tracker 地址（多个用 | 分隔）' }]
            },
            removeAll: { title: '清空全部', fields: [] }
        };

        const TEMPLATE = `
<style>
.qbtopt { padding: 12px 18px; font-size: 14px; line-height: 22px; }
.qbtopt h3 { margin: 0 0 6px; font-size: 16px; }
.qbtopt .qbtopt-hint { opacity: .8; margin: 0 0 10px; }
.qbtopt .qbtopt-modes { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-bottom: 10px; }
.qbtopt label { cursor: pointer; }
.qbtopt input[type="text"] { width: 100%; box-sizing: border-box; margin: 2px 0 8px; }
.qbtopt .qbtopt-run { margin-top: 4px; }
.qbtopt .qbtopt-msg { white-space: pre-wrap; margin-left: 8px; }
.qbtopt .qbtopt-msg.is-error { color: var(--color-text-red, #e74c3c); }
</style>
<div class="qbtopt">
  <h3>Tracker 批量管理</h3>
  <p class="qbtopt-hint">按标签或分类筛选种子；填写 <b>*</b> 表示全部种子，请谨慎使用。</p>
  <p><b>操作模式</b></p>
  <div class="qbtopt-modes">
    ${Object.entries(ACTIONS).map(([value, action], index) =>
        `<label><input type="radio" name="qbtopt-mode" class="qbtopt-mode" value="${value}"${index === 0 ? ' checked' : ''}> ${action.title}</label>`
    ).join('')}
  </div>
  <p><b>标签或分类</b><input type="text" class="qbtopt-filter" placeholder="例如：Mikan、Movies"></p>
  <div class="qbtopt-fields"></div>
  <p><button class="qbtopt-run">执行</button><span class="qbtopt-msg"></span></p>
</div>`;

        function request(options) {
            return new Promise((resolve, reject) => {
                GM_xmlhttpRequest(Object.assign({}, options, {
                    withCredentials: true,
                    timeout: 15000,
                    onload(response) {
                        if (response.status >= 200 && response.status < 300) {
                            resolve(response);
                            return;
                        }
                        const detail = String(response.responseText || '').trim().slice(0, 120);
                        reject(new Error(`HTTP ${response.status}${detail ? `：${detail}` : ''}`));
                    },
                    onerror() { reject(new Error('network error')); },
                    ontimeout() { reject(new Error('timeout')); }
                }));
            });
        }

        function apiGet(path) {
            return request({
                method: 'GET',
                url: apiBase + path,
                headers: { Accept: 'application/json, text/plain, */*' }
            }).then(response => {
                const text = response.responseText || '';
                try {
                    return JSON.parse(text);
                } catch (_) {
                    return text;
                }
            });
        }

        function apiPost(path, data) {
            const body = new URLSearchParams();
            Object.keys(data).forEach(key => body.append(key, data[key]));
            return request({
                method: 'POST',
                url: apiBase + path,
                data: body.toString(),
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                    Accept: 'application/json, text/plain, */*'
                }
            });
        }

        // qBittorrent 5.x 将 editTracker 的旧地址参数由 origUrl 改名为 url。
        // 两个参数同时发送：5.x 读取 url，4.x 读取 origUrl，彼此忽略多余字段。
        function editTrackerPayload(hash, origUrl, newUrl) {
            return { hash, url: origUrl, origUrl, newUrl };
        }

        function compareVersion(a, b) {
            const left = String(a || '').split('.').map(part => Number.parseInt(part, 10) || 0);
            const right = String(b || '').split('.').map(part => Number.parseInt(part, 10) || 0);
            for (let i = 0; i < Math.max(left.length, right.length); i++) {
                const x = left[i] || 0;
                const y = right[i] || 0;
                if (x > y) return 1;
                if (x < y) return -1;
            }
            return 0;
        }

        async function getHashes(filter) {
            const value = String(filter || '').trim();
            if (!value || value === '*' || /^(全部|所有)$/.test(value)) {
                const list = await apiGet('torrents/info');
                return Array.isArray(list) ? list.map(torrent => torrent.hash) : [];
            }

            // tag 参数自 Web API v2.8.3 起支持；低版本只查分类。
            const modes = compareVersion(webApiVersion, '2.8.3') >= 0 ? ['tag', 'category'] : ['category'];
            for (const mode of modes) {
                try {
                    const list = await apiGet(`torrents/info?${mode}=${encodeURIComponent(value)}`);
                    if (Array.isArray(list) && list.length) return list.map(torrent => torrent.hash);
                } catch (error) {
                    console.debug(`[QBT Opt] torrents/info?${mode} failed:`, error.message);
                }
            }
            return [];
        }

        // 返回值表示该种子实际修改的 Tracker 条数，用于区分「处理完成」与「真的改到了」。
        async function performAction(action, hash, data) {
            switch (action) {
                case 'replace':
                    await apiPost('torrents/editTracker',
                        editTrackerPayload(hash, data.origUrl, data.newUrl));
                    return 1;
                case 'keywordReplace': {
                    const trackers = await apiGet(`torrents/trackers?hash=${encodeURIComponent(hash)}`);
                    if (!Array.isArray(trackers)) throw new Error('获取 Tracker 失败');
                    const targets = trackers.filter(tracker => String(tracker.url || '').includes(data.origUrl));
                    for (const tracker of targets) {
                        const url = String(tracker.url);
                        await apiPost('torrents/editTracker', editTrackerPayload(
                            hash,
                            url,
                            data.replaceWhole ? data.newUrl : url.split(data.origUrl).join(data.newUrl)
                        ));
                    }
                    return targets.length;
                }
                case 'add':
                    await apiPost('torrents/addTrackers', { hash, urls: data.trackerUrl });
                    return 1;
                case 'remove':
                    await apiPost('torrents/removeTrackers', { hash, urls: data.trackerUrl });
                    return 1;
                case 'removeAll': {
                    const trackers = await apiGet(`torrents/trackers?hash=${encodeURIComponent(hash)}`);
                    if (!Array.isArray(trackers) || !trackers.length) return 0;
                    const urls = trackers.map(tracker => tracker.url).join('|');
                    await apiPost('torrents/removeTrackers', { hash, urls });
                    return trackers.length;
                }
                default:
                    throw new Error(`未知操作：${action}`);
            }
        }

        async function runBatch(action, data, onProgress) {
            let hashes;
            try {
                hashes = await getHashes(data.filter);
            } catch (error) {
                return { total: 0, ok: 0, fail: 0, error: `获取种子列表失败：${error.message}` };
            }
            if (!hashes.length) {
                return { total: 0, ok: 0, fail: 0, error: '没有符合条件的种子，请确认标签或分类存在。' };
            }

            // 过滤掉 API 返回的无效 hash，避免把 undefined 当成种子提交。
            const validHashes = hashes.filter(hash => typeof hash === 'string' && hash.length > 0);
            if (!validHashes.length) {
                return { total: 0, ok: 0, fail: 0, error: '种子列表中的 hash 均无效，请检查 WebUI 是否正常。' };
            }

            // 分块并发：每块 concurrency 个同时处理，块与块之间串行。
            // 并发数强制至少为 1，避免任何情况下算出 0 导致 worker 完全不执行。
            const results = [];
            const concurrency = Math.max(1, Math.min(6, validHashes.length));
            console.info(`[QBT Opt] batch start: action=${action}, found=${hashes.length}, valid=${validHashes.length}, concurrency=${concurrency}`);

            for (let i = 0; i < validHashes.length; i += concurrency) {
                const chunk = validHashes.slice(i, i + concurrency);
                const chunkResults = await Promise.all(chunk.map(async hash => {
                    try {
                        const changed = await performAction(action, hash, data);
                        return { ok: true, hash, changed: Number(changed) || 0 };
                    } catch (error) {
                        return { ok: false, hash, changed: 0, message: `${String(hash).slice(0, 8)}… ${error.message}` };
                    }
                }));
                results.push(...chunkResults);
                const processed = results.length;
                const ok = results.reduce((sum, item) => sum + (item.ok ? 1 : 0), 0);
                onProgress?.(processed, validHashes.length, ok, processed - ok);
            }

            const ok = results.reduce((sum, item) => sum + (item.ok ? 1 : 0), 0);
            const fail = results.length - ok;
            const changed = results.reduce((sum, item) => sum + item.changed, 0);
            const noMatch = results.filter(item => item.ok && item.changed === 0).length;
            const errors = results.filter(item => !item.ok).slice(0, 5).map(item => item.message);
            console.info(
                `[QBT Opt] batch finish: total=${validHashes.length}, processed=${results.length}, ` +
                `ok=${ok}, fail=${fail}, changedTrackers=${changed}, noMatchTorrents=${noMatch}, ` +
                `concurrency=${concurrency}`
            );
            return { total: validHashes.length, ok, fail, changed, noMatch, errors, processed: results.length };
        }

        function setMessage(text, isError) {
            const el = document.querySelector('#qbtopt-modal_content .qbtopt-msg');
            if (!el) {
                // UI 节点缺失时不能静默吞掉结果，至少在控制台留痕。
                console[isError ? 'warn' : 'info'](`[QBT Opt] ${text}`);
                return;
            }
            el.textContent = text;
            el.classList.toggle('is-error', Boolean(isError));
        }

        function renderFields(mode) {
            const box = document.querySelector('#qbtopt-modal_content .qbtopt-fields');
            if (!box) return;
            const action = ACTIONS[mode] || ACTIONS.replace;
            box.innerHTML = action.fields.map(field =>
                `<p><label><span class="qbtopt-label-text" data-label="${field.label}" data-whole-label="${field.wholeLabel || field.label}">${field.label}</span>` +
                `<input type="text" class="qbtopt-input" name="${field.name}"></label></p>`
            ).join('');

            if (action.checkbox) {
                box.insertAdjacentHTML('beforeend',
                    `<p><label><input type="checkbox" class="qbtopt-checkbox" name="${action.checkbox.name}"> ${action.checkbox.label}</label></p>`
                );
                box.querySelector('.qbtopt-checkbox').addEventListener('change', event => {
                    box.querySelectorAll('.qbtopt-label-text').forEach(label => {
                        if (label.dataset.wholeLabel === label.dataset.label) return;
                        label.textContent = event.target.checked ? label.dataset.wholeLabel : label.dataset.label;
                    });
                });
            }
        }

        function validate(mode, data) {
            if (mode === 'replace') {
                if (!urlPattern.test(data.origUrl) || !urlPattern.test(data.newUrl)) {
                    return '完整替换模式需要填写 udp:// 或 http(s):// 开头的 Tracker 地址。';
                }
            } else if (mode === 'keywordReplace') {
                if (!data.origUrl || !data.newUrl) return '关键字替换模式需要填写旧关键字和新内容。';
                if (data.replaceWhole && !urlPattern.test(data.newUrl)) {
                    return '已勾选整条替换，新 Tracker 必须是合法的 Tracker 地址（udp:// 或 http(s)://）。';
                }
            } else if (mode === 'add' || mode === 'remove') {
                if (!data.trackerUrl || !data.trackerUrl.split('|').every(url => urlPattern.test(url.trim()))) {
                    return '请填写合法的 Tracker 地址（udp:// 或 http(s)://），多个地址用 | 分隔。';
                }
            }
            return '';
        }

        async function handleRun(button) {
            if (running) return;
            const modal = document.querySelector('#qbtopt-modal_content');
            if (!modal) return;

            const mode = modal.querySelector('input[name="qbtopt-mode"]:checked')?.value;
            const filter = modal.querySelector('.qbtopt-filter')?.value.trim();
            if (!filter) {
                setMessage('请填写标签或分类；填写 * 表示全部种子。', true);
                return;
            }

            const data = { filter };
            modal.querySelectorAll('.qbtopt-input').forEach(input => {
                data[input.name] = input.value.trim();
            });
            data.replaceWhole = Boolean(modal.querySelector('.qbtopt-checkbox')?.checked);
            if (mode === 'add' || mode === 'remove') {
                data.trackerUrl = String(data.trackerUrl || '').split('|').map(url => url.trim()).join('|');
            }

            const error = validate(mode, data);
            if (error) {
                setMessage(error, true);
                return;
            }
            if (mode === 'removeAll' && !confirm('将清空匹配种子的全部 Tracker，是否继续？')) return;

            running = true;
            button.disabled = true;
            setMessage('正在获取种子列表…', false);
            try {
                const result = await runBatch(mode, data, (done, total, ok, fail) => {
                    setMessage(`处理中：${done}/${total}（成功 ${ok}，失败 ${fail}）`, false);
                });
                let message = result.error || (
                    `完成：共 ${result.total} 个种子，处理 ${result.processed}，` +
                    `成功 ${result.ok}，失败 ${result.fail}；` +
                    `实际修改 ${result.changed || 0} 条 Tracker，未命中 ${result.noMatch || 0} 个种子。`
                );
                if (result.errors?.length) message += `\n失败示例：${result.errors.join('；')}`;
                setMessage(message, Boolean(result.error || result.fail));
            } finally {
                running = false;
                button.disabled = false;
            }
        }

        function openModal() {
            if (typeof MochaUI === 'undefined' || !MochaUI.Window) {
                alert('未找到 MochaUI，请确认 qBittorrent WebUI 已完成加载。');
                return;
            }
            new MochaUI.Window({
                id: 'qbtopt-modal',
                title: 'Tracker 批量管理',
                loadMethod: 'iframe',
                contentURL: '',
                scrollbars: true,
                resizable: true,
                maximizable: false,
                closable: true,
                paddingVertical: 0,
                paddingHorizontal: 0,
                width: 540,
                height: 440
            });
            const content = document.querySelector('#qbtopt-modal_content');
            if (!content) {
                console.warn('[QBT Opt] modal content node not found');
                return;
            }
            content.innerHTML = TEMPLATE;
            const wrapper = document.querySelector('#qbtopt-modal_contentWrapper');
            if (wrapper) wrapper.style.height = 'auto';
            renderFields('replace');
        }

        function insertEntry() {
            if (document.querySelector('.js-qbtopt-modal')) return;
            const nav = document.querySelector('#desktopNavbar ul');
            if (!nav) return;
            const item = document.createElement('li');
            item.innerHTML = '<a class="js-qbtopt-modal"><b>→ Tracker 批量管理 ←</b></a>';
            nav.appendChild(item);
            item.querySelector('a').addEventListener('click', openModal);
        }

        function waitForNav(attempts = 0) {
            if (document.querySelector('#desktopNavbar ul')) {
                insertEntry();
                return;
            }
            if (attempts < 200) setTimeout(() => waitForNav(attempts + 1), 100);
        }

        function init() {
            // 防止用户脚本被重复安装/注入时绑定多套监听、并发执行同一批操作。
            if (PAGE.__QBT_OPT_TRACKER_READY__) {
                console.warn('[QBT Opt] Tracker tool already initialized; skip duplicate init.');
                return;
            }
            PAGE.__QBT_OPT_TRACKER_READY__ = true;

            document.addEventListener('change', event => {
                if (event.target.classList?.contains('qbtopt-mode')) {
                    renderFields(event.target.value);
                }
            });
            document.addEventListener('click', event => {
                const button = event.target.closest?.('.qbtopt-run');
                if (button) handleRun(button);
            });
            waitForNav();
            apiGet('app/webapiVersion')
                .then(version => { webApiVersion = String(version); })
                .catch(error => console.warn('[QBT Opt] webapiVersion unavailable:', error.message));
        }

        return { init, apiBase: () => apiBase };
    })();

    /* =====================================================================
     * 三、启动与诊断
     * ===================================================================== */

    PAGE.__QBT_OPT_DEBUG__ = {
        version: CONFIG.version,
        patched: () => Boolean(PAGE.qBittorrent?.DynamicTable?.TorrentPeersTable?.__QBT_OPT_PATCHED__),
        peerTable: () => peerTable,
        cacheSize: () => Object.keys(cache).length,
        apiBase: TrackerTool.apiBase,
        toggles: () => ({
            tracker: CONFIG.enableTrackerTool,
            peer: CONFIG.enablePeerInfo
        }),
        clearCache: () => {
            cache = {};
            localStorage.removeItem(CONFIG.cacheKey);
            console.info('[QBT Opt] IP cache cleared');
            refreshPeerColumns();
        }
    };

    // 管理器下拉菜单中的开关项：点击即切换并保存，确认后刷新页面生效。
    function registerMenuToggles() {
        if (typeof GM_registerMenuCommand !== 'function') {
            console.warn('[QBT Opt] GM_registerMenuCommand unavailable; menu toggles skipped.');
            return;
        }

        const toggles = [
            {
                key: TOGGLE_KEYS.tracker,
                name: 'Tracker 批量管理',
                getValue: () => CONFIG.enableTrackerTool,
                setValue(value) { CONFIG.enableTrackerTool = value; }
            },
            {
                key: TOGGLE_KEYS.peer,
                name: 'Peer 归属地/运营商',
                getValue: () => CONFIG.enablePeerInfo,
                setValue(value) { CONFIG.enablePeerInfo = value; }
            }
        ];

        toggles.forEach(item => {
            // 标题同时给出当前状态与点击后的动作，避免把动作误读成状态。
            const title = () => `${item.name}：${item.getValue() ? '已开启' : '已关闭'}（点击${item.getValue() ? '关闭' : '开启'}）`;
            GM_registerMenuCommand(title(), () => {
                const next = !item.getValue();
                const action = next ? '开启' : '关闭';
                if (!confirm(`确定要${action}「${item.name}」吗？\n开关切换后需要刷新 WebUI 页面才能生效。`)) return;
                writeToggle(item.key, next);
                item.setValue(next);
                console.info(`[QBT Opt] ${item.name} => ${next ? 'enabled' : 'disabled'}; reloading page`);
                location.reload();
            });
        });
    }

    registerMenuToggles();

    if (CONFIG.enablePeerInfo) installPeerInfoModule();

    if (CONFIG.enableTrackerTool) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => TrackerTool.init(), { once: true });
        } else {
            TrackerTool.init();
        }
    }

    window.addEventListener('load', () => {
        console.info(
            `[QBT Opt] v${CONFIG.version} loaded. ` +
            `Tracker=${CONFIG.enableTrackerTool}, PeerInfo=${CONFIG.enablePeerInfo}, ` +
            `DynamicTable patched=${PAGE.__QBT_OPT_DEBUG__.patched()}`
        );
    }, { once: true });
})();
