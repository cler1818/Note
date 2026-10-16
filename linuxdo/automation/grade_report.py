"""Read the installed helper's exact Connect counters and report retention risks."""
import json
import math
import re
import time
from datetime import datetime, timedelta, timezone

BJ = timezone(timedelta(hours=8))
EXT = 'chrome-extension://dhdgffkkebhmkfjojejmpbldmpobfkfo/'
# Matches the helper's ten-minute grade-cache lifetime. Older values are not a pass.
MAX_AGE_MS = 10 * 60 * 1000
METRICS = (
    ('topics_viewed', '浏览话题', '个'), ('posts_viewed', '浏览帖子', '篇'),
    ('topics_replied', '回复主题', '个主题'), ('likes_given', '点赞', '次'),
    ('likes_received', '获赞', '次'), ('liked_days', '获赞天数', '天'),
    ('liked_by_users', '获赞用户', '人'),
)
COMPLIANCE = {'reported_posts': '被举报帖子', 'users_reported': '举报用户',
              'muted': '禁言', 'banned': '封禁'}

IDENTITY_JS = r'''JSON.stringify((()=>{
 let h={};try{h=JSON.parse(document.documentElement.getAttribute('data-ldh-health')||'{}')}catch(e){}
 const text=document.getElementById('ldh_r1')?.textContent||'';
 const level=text.match(/\bTL(\d+)\b/);
 let summary=null;
 if(h.user){try{summary=JSON.parse(localStorage.getItem('ldh_summary_'+String(h.user).trim().toLowerCase())||'null')}catch(e){}}
 return {username:String(h.user||''),authenticated:h.account==='authenticated',
         trustLevel:level?Number(level[1]):null,
         visitSummary:summary?{at:summary.at,visitDays:summary.data?.visitDays}:null};
})())'''

# Select only the active helper's grade entry in the browser. Never export other GM values.
GRADE_JS = r'''(async()=>{
 const user=__USER__,un=v=>{if(v&&typeof v==='object'&&'value'in v)v=v.value;
   if(typeof v==='string'){try{return JSON.parse(v)}catch(e){}}return v};
 const d=await new Promise(resolve=>chrome.storage.local.get(null,resolve));
 const keys=Object.keys(d).filter(k=>k.startsWith('!extdb.@meta#')).filter(k=>{
   const m=un(d[k]);return m&&/^LINUX[\s._-]*DO.*助手$/i.test(m.name||'')&&m.enabled&&!m.deleted;
 });
 if(keys.length!==1)return JSON.stringify({error:'助手数量异常'});
 const s=un(d['!extdb.@st#'+keys[0].split('#')[1]]),data=s?.data||{};
 const value=k=>{let v=data[k];if(typeof v==='string'&&/^[sonb]/.test(v))v=v.slice(1);return un(v)};
 const current=String(value('ldh_current_ld_user')||'').trim().toLowerCase();
 if(current!==user)return JSON.stringify({error:'账号与助手缓存不一致'});
 const g=value('ld_tl3_'+user);
 if(!g||typeof g!=='object')return JSON.stringify({error:'尚未同步等级条件'});
 if(g.account&&String(g.account).trim().toLowerCase()!==user)return JSON.stringify({error:'等级数据账号不一致'});
 const fields=['visit_days','topics_viewed','posts_viewed','topics_replied','likes_given','likes_received','liked_days','liked_by_users'];
 const metrics=Object.fromEntries(fields.filter(k=>g.metrics&&k in g.metrics).map(k=>[k,{c:g.metrics[k]?.c,r:g.metrics[k]?.r}]));
 const checks=['reported_posts','users_reported','muted','banned'];
 return JSON.stringify({grade:{at:g.at,locked:!!g.locked,metrics,
   compliance:Object.fromEntries(checks.filter(k=>g.compliance&&k in g.compliance).map(k=>[k,g.compliance[k]]))}});
})()'''


def collect_grade(A, result):
    """Bounded, read-only capture before this environment closes; no new network requests."""
    check = {'status': 'unavailable', 'username': '', 'trustLevel': None,
             'observedAt': int(time.time() * 1000), 'reason': '未取得等级数据'}
    fallback = (result.get('state') or {}).get('health') or {}
    check['username'] = str(fallback.get('user') or '').strip()
    if result.get('forumOnly'):
        return dict(check, reason='本次使用仅论坛模式，未检查等级')
    cdp = result.get('cdp')
    if result.get('closed') or cdp is None or getattr(cdp, 'dead', False):
        return dict(check, reason='浏览器启动或连接失败，未检查等级')
    connection = None
    created = False
    try:
        identity = cdp.evj(IDENTITY_JS) or {}
        if identity.get('authenticated') and identity.get('username'):
            check.update(username=str(identity['username']).strip(), trustLevel=identity.get('trustLevel'))
        elif result.get('loginStatus') == 'authenticated' and check['username']:
            # A late CF page must not discard the account authenticated earlier in this run.
            # Its identity is checked again against the helper's stored current account below.
            previous = re.search(r'\bTL(\d+)\b', str((result.get('state') or {}).get('r1') or ''))
            check['trustLevel'] = int(previous.group(1)) if previous else None
        else:
            return dict(check, reason='当前登录身份未确认，未检查等级')
        if check['trustLevel'] in (0, 1):
            summary = identity.get('visitSummary') or {}
            days = count(summary.get('visitDays'))
            if days is not None:
                return dict(check, status='summary_only', reason='', visitDays=days, dataAt=summary.get('at'))
            return dict(check, reason='访问天数摘要尚未读取')
        deadline = time.monotonic() + 8
        targets = [t for t in cdp._http('/json/list') if t.get('url', '').startswith(EXT)
                   and t.get('type') in ('service_worker', 'background_page', 'page')]
        targets.sort(key=lambda t: t.get('type') == 'page')
        if targets:
            connection = A.CDP(cdp.port, target_id=targets[0]['id'], timeout=3, deadline=deadline)
        else:
            connection = A.CDP(cdp.port, url='about:blank', timeout=3, deadline=deadline)
            created = True
            connection.send('Page.navigate', {'url': EXT + 'options.html'})
        while time.monotonic() < deadline:
            if connection.ev('!!globalThis.chrome?.storage?.local'):
                break
            time.sleep(.15)
        else:
            return dict(check, reason='助手存储未就绪，未检查等级')
        expression = GRADE_JS.replace('__USER__', json.dumps(check['username'].lower()))
        captured = connection.evj(expression, await_promise=True) or {}
        if not isinstance(captured.get('grade'), dict):
            return dict(check, reason=captured.get('error') or '等级数据读取失败')
        check.update(status='captured', reason='', grade=captured['grade'], observedAt=int(time.time() * 1000))
        return check
    except Exception as error:
        return dict(check, reason='等级读取异常：' + type(error).__name__)
    finally:
        if connection:
            if created:
                try:
                    connection._http('/json/close/' + connection.target_id)
                except Exception:
                    pass
            connection.close()


def count(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if not math.isfinite(value) or value < 0 or int(value) != value:
        return None
    return int(value)


def pair(metrics, key):
    value = metrics.get(key)
    if not isinstance(value, dict):
        return None
    current, required = count(value.get('c')), count(value.get('r'))
    return None if current is None or required is None else (current, required)


def stamp(ms):
    try:
        return datetime.fromtimestamp(ms / 1000, BJ).strftime('%Y-%m-%d %H:%M:%S')
    except (TypeError, ValueError, OSError, OverflowError):
        return '未知'


def assess(result):
    check = result.get('gradeCheck') or {}
    row = {'id': result['id'], 'username': check.get('username') or '账号未确认',
           'trustLevel': check.get('trustLevel'), 'status': 'unknown', 'shortfalls': [],
           'reason': check.get('reason') or '本次未取得等级数据'}
    if check.get('status') == 'summary_only' and count(check.get('visitDays')) is not None:
        return dict(row, status='summary_only', visitDays=check['visitDays'], dataAt=stamp(check.get('dataAt')))
    if check.get('status') == 'not_applicable':
        return dict(row, status='not_applicable')
    grade = check.get('grade')
    if check.get('status') != 'captured' or not isinstance(grade, dict):
        return row
    metrics = grade.get('metrics') or {}
    missing = []
    visit = pair(metrics, 'visit_days')
    if visit:
        row['visitDays'] = visit[0]
    for key, label, unit in METRICS:
        values = pair(metrics, key)
        if values is None:
            missing.append(label)
        elif values[0] < values[1]:
            row['shortfalls'].append(f'{label} {values[0]}/{values[1]}（差 {values[1]-values[0]} {unit}）')
    at, observed = grade.get('at'), check.get('observedAt')
    row['dataAt'] = stamp(at)
    row['missingMetrics'] = missing
    if grade.get('locked'):
        return dict(row, reason='Connect未提供3级条件')
    if not isinstance(at, (int, float)) or not isinstance(observed, (int, float)) or not (0 <= observed - at <= MAX_AGE_MS) or stamp(at)[:10] != stamp(observed)[:10]:
        return dict(row, reason='仅有旧数据或同步时间异常，不能确认当前条件')
    if not visit:
        return dict(row, reason='访问天数缺失，不能筛选')
    if visit[0] < 50:
        return dict(row, status='under_50', reason='访问天数不足50')
    compliance = grade.get('compliance') or {}
    notices = [f'{label} {compliance[key]}' for key, label in COMPLIANCE.items()
               if count(compliance.get(key)) is not None and compliance[key] > 0]
    row['complianceNotices'] = notices
    if row['shortfalls']:
        return dict(row, status='risk', reason='访问天数≥50，其余数值条件未满足')
    if missing:
        return dict(row, reason='等级数据不全：' + '、'.join(missing))
    if notices:
        # Cached compliance entries lack quota targets; a positive count alone is not a confirmed violation.
        return dict(row, reason='数值条件已达标，合规记录及站点门槛需人工复核：' + '、'.join(notices))
    if any(count(compliance.get(key)) is None for key in COMPLIANCE):
        return dict(row, reason='数值条件已达标，合规数据不全')
    return dict(row, status='met', reason='当前条件已满足')


def retention_summary_line(results):
    ids = set()
    for result in results:
        check = result.get('gradeCheck') or {}
        days = count(check.get('visitDays'))
        if days is None:
            metric = ((check.get('grade') or {}).get('metrics') or {}).get('visit_days') or {}
            days = count(metric.get('c'))
        # The user wants every browser with at least 50 visit days, regardless of
        # trust level, fulfilled requirements, or the separate risk assessment.
        if days is not None and days >= 50:
            ids.add(result['id'])
    numbers = ','.join(str(env) for env in sorted(ids)) if ids else '无（已读取的访问天数中）'
    return '  需续保3级的浏览器编号：' + numbers


def report_lines(results, now=None):
    rows = [assess(r) for r in sorted(results, key=lambda r: r['id'])]
    risks = [r for r in rows if r['status'] == 'risk']
    unknown = [r for r in rows if r['status'] == 'unknown']
    lines = ['', '=' * 58, '【访问≥50天、其他条件未满足的账号】',
             '检查时间：' + (now or datetime.now(BJ)).strftime('%Y-%m-%d %H:%M:%S'),
             f'本次 {len(rows)} 个环境；条件缺项 {len(risks)} 个；待复核 {len(unknown)} 个。']
    if risks:
        lines.append('需处理的浏览器编号：' + ','.join(str(r['id']) for r in risks))
        for r in risks:
            level = r['trustLevel']
            label = '保级风险' if level == 3 else '未达3级条件' if level == 2 else '等级条件缺项'
            tl = f'TL{level}' if level is not None else '等级未知'
            lines.append(f"  浏览器{r['id']} | @{r['username']} | {tl} | 访问 {r['visitDays']} 天 | {label}")
            lines.append('    ' + '；'.join(r['shortfalls']))
            lines.append('    数据同步：' + r['dataAt'])
            if r['missingMetrics']:
                lines.append('    另有未读取条件：' + '、'.join(r['missingMetrics']))
            if r['complianceNotices']:
                lines.append('    合规记录需复核：' + '、'.join(r['complianceNotices']))
    else:
        lines.append('本次已核验的数据中未发现符合上述筛选条件的账号。')
    lines.append('回复主题指 Connect 的实际回复主题数，不是本轮登记的阅读篇数。')
    lines.append('TL3缺项表示保级风险；是否及何时降级以站点检查和保护期为准。')
    if unknown:
        lines.extend(['', '【待复核：数据缺失/过旧，不视为达标】'])
        for r in unknown:
            detail = f"  浏览器{r['id']} | @{r['username']} | {r['reason']}"
            if 'visitDays' in r:
                detail += f"；记录访问 {r['visitDays']} 天；同步 {r['dataAt']}"
            if r.get('visitDays', 0) >= 50 and r['shortfalls']:
                detail += '；已记录缺项：' + '；'.join(r['shortfalls'])
            lines.append(detail)
    lines.append('=' * 58)
    return lines


def print_grade_report(results, log, log_dir, now=None):
    """Send detail through the existing autorun logger; never create another log."""
    now = now or datetime.now(BJ)
    lines = report_lines(results, now)
    for line in lines:
        log(line)
