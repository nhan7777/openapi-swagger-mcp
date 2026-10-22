// Builds bench/search/dev2/: development additions D1-D4 as a format-1 dataset (see ../dataset-format.md).
//   D4: two new specs, `hr` (Vietnamese-heavy) and `media` (English, allOf, shared request/response field names)
//   D1: positive queries for the 13 positive categories, D2: weak-evidence positives (flag `weak`), D3: no_result queries
// Labels are written by hand below and resolved against the specs; none comes from search output. The tuner may read
// and tune on this dataset. Run: node bench/search/corpus/build-dev2.mjs && node bench/search/make-manifest.mjs
// bench/search/dev2 --batch dev2-1 --kind dev2
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, '..', 'dev2');
const specsOut = path.join(out, 'specs');
fs.mkdirSync(specsOut, { recursive: true });

// ---- spec helpers (same shape as build-specs.mjs) ---------------------------------------------------------------
const T = (t) => (typeof t === 'string' ? { type: t } : t);
const obj = (props, extra = {}) => ({ type: 'object', properties: Object.fromEntries(Object.entries(props).map(([k, v]) => [k, T(v)])), ...extra });
const arr = (items) => ({ type: 'array', items: T(items) });
const ref = (n) => ({ $ref: `#/components/schemas/${n}` });
const desc = (t, d) => ({ ...T(t), description: d });
const json = (schema) => ({ content: { 'application/json': { schema } } });
function op(method, p, operationId, summary, description, o = {}) {
  const params = [...p.matchAll(/\{([^}]+)\}/g)].map((m) => ({ in: 'path', name: m[1], required: true, schema: { type: 'string' } }));
  for (const q of o.query ?? []) {
    const [name, d] = Array.isArray(q) ? q : [q, undefined];
    params.push({ in: 'query', name, required: false, schema: { type: 'string' }, ...(d ? { description: d } : {}) });
  }
  const node = {
    operationId,
    summary,
    ...(description ? { description } : {}),
    ...(o.tags ? { tags: o.tags } : {}),
    ...(params.length ? { parameters: params } : {}),
    ...(o.req ? { requestBody: { required: true, ...json(o.req) } } : {}),
    responses: { [o.resStatus ?? (method === 'post' ? '201' : '200')]: { description: 'ok', ...(o.res ? json(o.res) : {}) }, default: { description: 'error', ...json(ref('Error')) } },
  };
  return [p, method, node];
}
function doc(title, ops, schemas) {
  const paths = {};
  for (const [p, m, node] of ops) (paths[p] ??= {})[m] = node;
  return { openapi: '3.0.3', info: { title, version: '1.0.0' }, paths, components: { schemas: { Error: obj({ code: 'string', message: 'string' }), ...schemas } } };
}

// ---- hr: Vietnamese-heavy HR system -----------------------------------------------------------------------------
const hrSchemas = {
  Address: obj({ province: 'string', district: 'string', street: 'string' }),
  Employee: obj({
    employeeId: 'string',
    fullName: desc('string', 'Họ và tên'),
    department: 'string',
    position: 'string',
    status: 'string',
    address: ref('Address'),
    emergencyContact: obj({ fullName: 'string', relationship: desc('string', 'Quan hệ với nhân viên'), phone: 'string' }),
  }),
  EmployeeInput: obj({ fullName: 'string', department: 'string', position: 'string', startDate: 'string' }),
};
const hr = doc('HR', [
  op('get', '/employees', 'listEmployees', 'Danh sách nhân viên', undefined, { tags: ['employees'], query: ['department', 'status'], res: obj({ items: arr(ref('Employee')) }) }),
  op('post', '/employees', 'createEmployee', 'Thêm nhân viên mới', undefined, { tags: ['employees'], req: ref('EmployeeInput'), res: ref('Employee') }),
  op('get', '/employees/{employeeId}', 'getEmployee', 'Thông tin nhân viên', undefined, { tags: ['employees'], res: ref('Employee') }),
  op('put', '/employees/{employeeId}', 'updateEmployee', 'Cập nhật hồ sơ nhân viên', undefined, { tags: ['employees'], req: ref('EmployeeInput'), res: ref('Employee'), resStatus: '200' }),
  op('delete', '/employees/{employeeId}', 'terminateEmployee', 'Chấm dứt hợp đồng nhân viên', undefined, { tags: ['employees'], query: [['reason', 'Lý do chấm dứt']] }),
  op('get', '/employees/{employeeId}/contracts', 'listContracts', 'Hợp đồng lao động', undefined, { tags: ['contracts'], res: obj({ items: arr(obj({ contractId: 'string', contractType: 'string', startDate: 'string' })) }) }),
  op('post', '/employees/{employeeId}/contracts', 'createContract', 'Ký hợp đồng lao động', undefined, { tags: ['contracts'], req: obj({ contractType: 'string', startDate: 'string', baseSalary: 'number' }), res: obj({ contractId: 'string' }) }),
  op('get', '/departments', 'listDepartments', 'Danh sách phòng ban', undefined, { tags: ['departments'], res: obj({ items: arr(obj({ departmentId: 'string', name: 'string' })) }) }),
  op('post', '/departments', 'createDepartment', 'Tạo phòng ban', undefined, { tags: ['departments'], req: obj({ name: 'string', managerId: 'string' }), res: obj({ departmentId: 'string' }) }),
  op('get', '/departments/{departmentId}/members', 'listDepartmentMembers', 'Thành viên phòng ban', undefined, { tags: ['departments'], res: obj({ items: arr(obj({ employeeId: 'string', fullName: 'string' })) }) }),
  op('get', '/leave/requests', 'listLeaveRequests', 'Đơn xin nghỉ phép', undefined, { tags: ['leave'], query: ['status'], res: obj({ items: arr(obj({ requestId: 'string', leaveType: 'string', status: 'string' })) }) }),
  op('post', '/leave/requests', 'createLeaveRequest', 'Gửi đơn xin nghỉ phép', undefined, { tags: ['leave'], req: obj({ leaveType: 'string', fromDate: 'string', toDate: 'string', reason: 'string' }), res: obj({ requestId: 'string' }) }),
  op('post', '/leave/requests/{requestId}/approve', 'approveLeaveRequest', 'Duyệt đơn nghỉ phép', undefined, { tags: ['leave'], resStatus: '204' }),
  op('post', '/leave/requests/{requestId}/reject', 'rejectLeaveRequest', 'Từ chối đơn nghỉ phép', undefined, { tags: ['leave'], req: obj({ rejectionNote: 'string' }), resStatus: '204' }),
  op('get', '/leave/balance/{employeeId}', 'getLeaveBalance', 'Số ngày phép còn lại', undefined, { tags: ['leave'], res: obj({ remainingDays: 'number', usedDays: 'number' }) }),
  op('get', '/attendance/{employeeId}', 'getAttendance', 'Bảng chấm công', undefined, { tags: ['attendance'], query: ['month'], res: obj({ items: arr(obj({ date: 'string', checkInTime: 'string', checkOutTime: 'string' })) }) }),
  op('post', '/attendance/check-in', 'checkIn', 'Chấm công vào', undefined, { tags: ['attendance'], req: obj({ employeeId: 'string', location: 'string' }), res: obj({ recordedAt: 'string' }) }),
  op('post', '/attendance/check-out', 'checkOut', 'Chấm công ra', undefined, { tags: ['attendance'], req: obj({ employeeId: 'string' }), res: obj({ recordedAt: 'string' }) }),
  op('get', '/payroll/{month}', 'getPayroll', 'Bảng lương theo tháng', undefined, { tags: ['payroll'], res: obj({ month: 'string', grossSalary: 'number', netSalary: 'number' }) }),
  op('get', '/payroll/{month}/employees/{employeeId}', 'getPayslip', 'Phiếu lương', undefined, { tags: ['payroll'], res: obj({ employeeId: 'string', deductions: obj({ socialInsurance: 'number', personalIncomeTax: 'number' }) }) }),
  op('post', '/payroll/{month}/run', 'runPayroll', 'Chạy bảng lương', undefined, { tags: ['payroll'], resStatus: '202' }),
  op('get', '/insurance/{employeeId}', 'getInsurance', 'Thông tin bảo hiểm xã hội', 'Số sổ BHXH và mức đóng', { tags: ['insurance'], res: obj({ insuranceNumber: 'string', contributionLevel: 'number' }) }),
  op('get', '/recruitment/jobs', 'listJobPostings', 'Tin tuyển dụng', undefined, { tags: ['recruitment'], res: obj({ items: arr(obj({ jobId: 'string', title: 'string' })) }) }),
  op('post', '/recruitment/jobs', 'createJobPosting', 'Đăng tin tuyển dụng', undefined, { tags: ['recruitment'], req: obj({ title: 'string', requirements: 'string' }), res: obj({ jobId: 'string' }) }),
  op('get', '/recruitment/candidates', 'listCandidates', 'Danh sách ứng viên', 'Hồ sơ và CV của ứng viên', { tags: ['recruitment'], res: obj({ items: arr(obj({ candidateId: 'string', fullName: 'string' })) }) }),
  op('post', '/recruitment/candidates/{candidateId}/interview', 'scheduleInterview', 'Đặt lịch phỏng vấn', undefined, { tags: ['recruitment'], req: obj({ interviewTime: 'string', interviewer: 'string' }), res: obj({ interviewId: 'string' }) }),
  op('get', '/training/courses', 'listCourses', 'Khóa đào tạo', undefined, { tags: ['training'], res: obj({ items: arr(obj({ courseId: 'string', courseName: 'string' })) }) }),
  op('post', '/training/courses/{courseId}/enroll', 'enrollCourse', 'Đăng ký khóa đào tạo', undefined, { tags: ['training'], req: obj({ employeeId: 'string' }), resStatus: '204' }),
  op('get', '/performance/{employeeId}', 'getPerformanceReview', 'Đánh giá hiệu suất', 'Điểm KPI và mục tiêu', { tags: ['performance'], res: obj({ kpiScore: 'number', goals: arr(obj({ title: 'string', weight: 'number' })) }) }),
  op('post', '/performance/{employeeId}', 'submitPerformanceReview', 'Nộp đánh giá hiệu suất', 'Gửi điểm KPI', { tags: ['performance'], req: obj({ kpiScore: 'number', goals: arr(obj({ title: 'string', weight: 'number' })), comment: 'string' }), res: obj({ reviewId: 'string' }) }),
  op('get', '/holidays', 'listHolidays', 'Ngày nghỉ lễ', undefined, { tags: ['calendar'], res: obj({ items: arr(obj({ holidayDate: 'string', holidayName: 'string' })) }) }),
  op('get', '/positions', 'listPositions', 'Danh sách chức vụ', undefined, { tags: ['organization'], res: obj({ items: arr(obj({ positionId: 'string', positionName: 'string' })) }) }),
  op('get', '/offices', 'listOffices', 'Văn phòng làm việc', undefined, { tags: ['organization'], res: obj({ items: arr(obj({ officeId: 'string', officeAddress: 'string' })) }) }),
  op('post', '/documents/upload', 'uploadDocument', 'Tải tài liệu nhân sự', undefined, { tags: ['documents'], res: obj({ documentId: 'string' }) }),
  op('get', '/reports/headcount', 'getHeadcountReport', 'Báo cáo nhân sự', undefined, { tags: ['reports'], res: obj({ headcount: 'integer' }) }),
  op('get', '/reports/turnover', 'getTurnoverReport', 'Báo cáo biến động nhân sự', undefined, { tags: ['reports'], res: obj({ turnoverRate: 'number' }) }),
  op('get', '/benefits', 'listBenefits', 'Phúc lợi', undefined, { tags: ['benefits'], res: obj({ items: arr(obj({ benefitName: 'string' })) }) }),
  op('post', '/overtime/requests', 'createOvertimeRequest', 'Đăng ký làm thêm giờ', 'Gửi yêu cầu OT cho quản lý duyệt', { tags: ['attendance'], req: obj({ employeeId: 'string', overtimeHours: 'number', reason: 'string' }), res: obj({ requestId: 'string' }) }),
  op('get', '/health', 'getHrHealth', 'Kiểm tra tình trạng hệ thống', undefined, { tags: ['ops'] }),
  op('get', '/me/profile', 'getMyProfile', 'Hồ sơ của tôi', undefined, { tags: ['employees'], res: ref('Employee') }),
], hrSchemas);

// ---- media: English media platform, allOf, same field names in request and response -----------------------------
const mediaSchemas = {
  Asset: obj({ id: 'string', title: 'string', createdAt: 'string' }),
  Video: { allOf: [ref('Asset'), obj({ durationSeconds: 'number', language: 'string', thumbnailUrl: 'string' })] },
  VideoInput: { allOf: [obj({ title: 'string', language: 'string' }), obj({ tags: arr('string') })] },
};
const media = doc('Media', [
  op('get', '/videos', 'listVideos', 'List videos', undefined, { tags: ['videos'], query: ['channelId'], res: obj({ items: arr(ref('Video')) }) }),
  op('post', '/videos', 'uploadVideo', 'Upload a video', undefined, { tags: ['videos'], req: ref('VideoInput'), res: ref('Video') }),
  op('get', '/videos/{videoId}', 'getVideo', 'Get a video', undefined, { tags: ['videos'], res: ref('Video') }),
  op('patch', '/videos/{videoId}', 'updateVideo', 'Update a video', undefined, { tags: ['videos'], req: obj({ title: 'string', thumbnailUrl: 'string' }), res: ref('Video'), resStatus: '200' }),
  op('delete', '/videos/{videoId}', 'deleteVideo', 'Delete a video', undefined, { tags: ['videos'] }),
  op('get', '/videos/{videoId}/captions', 'listCaptions', 'List captions', undefined, { tags: ['captions'], res: obj({ items: arr(obj({ languageCode: 'string', cueCount: 'integer' })) }) }),
  op('post', '/videos/{videoId}/captions', 'addCaption', 'Add a caption track', 'Upload a WebVTT caption file for a video', { tags: ['captions'], req: obj({ languageCode: 'string', webvttBody: 'string' }), resStatus: '204' }),
  op('get', '/videos/{videoId}/renditions', 'listRenditions', 'List renditions', 'HLS and DASH renditions of a video', { tags: ['videos'], res: obj({ items: arr(obj({ bitrateKbps: 'integer', codec: 'string', resolution: 'string' })) }) }),
  op('post', '/videos/{videoId}/transcode', 'startTranscode', 'Start a transcode', undefined, { tags: ['jobs'], req: obj({ targetCodec: 'string', resolution: 'string' }), res: obj({ jobId: 'string' }) }),
  op('get', '/jobs/{jobId}', 'getTranscodeJob', 'Get a transcode job', undefined, { tags: ['jobs'], res: obj({ jobId: 'string', state: 'string', progressPercent: 'number', output: obj({ files: arr(obj({ url: 'string', sizeBytes: 'integer' })) }) }) }),
  op('get', '/playlists', 'listPlaylists', 'List playlists', undefined, { tags: ['playlists'], res: obj({ items: arr(obj({ playlistId: 'string', name: 'string' })) }) }),
  op('post', '/playlists', 'createPlaylist', 'Create a playlist', undefined, { tags: ['playlists'], req: obj({ name: 'string', description: 'string' }), res: obj({ playlistId: 'string' }) }),
  op('put', '/playlists/{playlistId}/items', 'setPlaylistItems', 'Replace playlist items', undefined, { tags: ['playlists'], req: obj({ videoIds: arr('string') }), resStatus: '204' }),
  op('get', '/playlists/{playlistId}', 'getPlaylist', 'Get a playlist', undefined, { tags: ['playlists'], res: obj({ playlistId: 'string', name: 'string' }) }),
  op('get', '/channels', 'listChannels', 'List channels', undefined, { tags: ['channels'], res: obj({ items: arr(obj({ channelId: 'string', name: 'string' })) }) }),
  op('get', '/channels/{channelId}', 'getChannel', 'Get a channel', undefined, { tags: ['channels'], res: obj({ channelId: 'string', name: 'string', subscriberCount: 'integer' }) }),
  op('post', '/channels/{channelId}/subscribe', 'subscribeChannel', 'Subscribe to a channel', undefined, { tags: ['channels'], resStatus: '204' }),
  op('get', '/comments', 'listComments', 'List comments', undefined, { tags: ['comments'], query: ['videoId'], res: obj({ items: arr(obj({ commentId: 'string', authorName: 'string', body: 'string' })) }) }),
  op('post', '/comments', 'postComment', 'Post a comment', undefined, { tags: ['comments'], req: obj({ videoId: 'string', body: 'string' }), res: obj({ commentId: 'string', body: 'string' }) }),
  op('delete', '/comments/{commentId}', 'removeComment', 'Remove a comment', undefined, { tags: ['comments'] }),
  op('get', '/analytics/views', 'getViewAnalytics', 'View analytics', undefined, { tags: ['analytics'], res: obj({ viewCount: 'integer', watchTimeSeconds: 'integer' }) }),
  op('get', '/analytics/audience', 'getAudienceAnalytics', 'Audience analytics', undefined, { tags: ['analytics'], res: obj({ segments: arr(obj({ countryCode: 'string', ageBucket: 'string' })) }) }),
  op('get', '/live/streams', 'listLiveStreams', 'List live streams', undefined, { tags: ['live'], res: obj({ items: arr(obj({ streamId: 'string', state: 'string' })) }) }),
  op('post', '/live/streams', 'startLiveStream', 'Start a live stream', 'Create an RTMP or SRT ingest endpoint', { tags: ['live'], req: obj({ title: 'string', ingestProtocol: 'string' }), res: obj({ streamId: 'string', streamKey: 'string', ingestUrl: 'string' }) }),
  op('post', '/live/streams/{streamId}/stop', 'stopLiveStream', 'Stop a live stream', undefined, { tags: ['live'], resStatus: '204' }),
  op('get', '/podcasts', 'listPodcasts', 'List podcasts', undefined, { tags: ['podcasts'], res: obj({ items: arr(obj({ podcastId: 'string', name: 'string' })) }) }),
  op('get', '/podcasts/{podcastId}/episodes', 'listEpisodes', 'List episodes', undefined, { tags: ['podcasts'], res: obj({ items: arr(obj({ episodeNumber: 'integer', title: 'string' })) }) }),
  op('post', '/podcasts/{podcastId}/episodes', 'publishEpisode', 'Publish an episode', undefined, { tags: ['podcasts'], req: obj({ title: 'string', audioUrl: 'string' }), res: obj({ episodeNumber: 'integer' }) }),
  op('get', '/images/{imageId}', 'getImage', 'Get an image', undefined, { tags: ['images'], res: obj({ imageId: 'string', widthPixels: 'integer' }) }),
  op('post', '/images', 'uploadImage', 'Upload an image', undefined, { tags: ['images'], res: obj({ imageId: 'string' }) }),
  op('get', '/licenses', 'listLicenses', 'List licenses', undefined, { tags: ['licenses'], res: obj({ items: arr(obj({ licenseId: 'string', licenseTerms: 'string' })) }) }),
  op('post', '/licenses/{licenseId}/grant', 'grantLicense', 'Grant a license', undefined, { tags: ['licenses'], req: obj({ licensee: 'string' }), resStatus: '204' }),
  op('get', '/moderation/flags', 'listModerationFlags', 'List moderation flags', undefined, { tags: ['moderation'], res: obj({ items: arr(obj({ flagId: 'string', reason: 'string' })) }) }),
  op('post', '/moderation/flags/{flagId}/resolve', 'resolveFlag', 'Resolve a flag', undefined, { tags: ['moderation'], req: obj({ resolution: 'string' }), resStatus: '204' }),
  op('get', '/search/suggest', 'suggestTitles', 'Suggest titles', undefined, { tags: ['search'], query: ['prefix'], res: obj({ suggestions: arr('string') }) }),
  op('get', '/recommendations', 'getRecommendations', 'Get recommendations', undefined, { tags: ['search'], res: obj({ items: arr(obj({ videoId: 'string', score: 'number' })) }) }),
  op('post', '/webhooks', 'registerMediaWebhook', 'Register a webhook', undefined, { tags: ['integration'], req: obj({ callbackUrl: 'string', events: arr('string') }), res: obj({ webhookId: 'string' }) }),
  op('get', '/billing/usage', 'getBillingUsage', 'Billing usage', 'Storage and CDN egress usage for the month', { tags: ['billing'], res: obj({ storageBytes: 'integer', egressBytes: 'integer', breakdown: obj({ byRegion: arr(obj({ regionCode: 'string', gigabytes: 'number' })) }) }) }),
  op('get', '/health', 'getMediaHealth', 'Health check', undefined, { tags: ['ops'] }),
  op('get', '/users/{userId}/history', 'getWatchHistory', 'Watch history', undefined, { tags: ['users'], res: obj({ items: arr(obj({ videoId: 'string', watchedAt: 'string' })) }) }),
], mediaSchemas);

fs.writeFileSync(path.join(specsOut, 'hr.json'), JSON.stringify(hr, null, 1) + '\n');
fs.writeFileSync(path.join(specsOut, 'media.json'), JSON.stringify(media, null, 1) + '\n');
for (const id of ['shop', 'crm-a', 'crm-b', 'cjk', 'erp']) fs.copyFileSync(path.join(here, 'specs', `${id}.json`), path.join(specsOut, `${id}.json`));

// ---- config.json ---------------------------------------------------------------------------------------------------
const ids = ['shop', 'crm-a', 'crm-b', 'cjk', 'erp', 'hr', 'media'];
const corpusAliases = JSON.parse(fs.readFileSync(path.join(here, '..', 'aliases.json'), 'utf8'));
const config = {
  version: 1,
  services: Object.fromEntries(ids.map((id, i) => [id, { baseUrl: `http://127.0.0.1:${9 + i}`, spec: { source: { file: `specs/${id}.json` } } }])),
  search: {
    aliases: [
      ...corpusAliases,
      { terms: ['time off', 'leave'], services: ['hr'] },
      { terms: ['salary', 'payroll'], services: ['hr'] },
      { terms: ['agreement', 'contract'], services: ['hr'] },
      { terms: ['staff', 'employee'], services: ['hr'] },
      { terms: ['team', 'department'], services: ['hr'] },
      { terms: ['clip', 'video'], services: ['media'] },
      { terms: ['subtitle', 'caption'], services: ['media'] },
      { terms: ['follow', 'subscribe'], services: ['media'] },
    ],
  },
};
fs.writeFileSync(path.join(out, 'config.json'), JSON.stringify(config, null, 2) + '\n');

// ---- labels ----------------------------------------------------------------------------------------------------------
const keyOf = new Map();
for (const id of ids) {
  const spec = JSON.parse(fs.readFileSync(path.join(specsOut, `${id}.json`), 'utf8'));
  for (const [p, item] of Object.entries(spec.paths)) for (const [m, node] of Object.entries(item)) keyOf.set(`${id}/${node.operationId}`, `${m.toUpperCase()} ${p}`);
}
const rows = [];
const counters = {};
/** P(category, lang, query, relevant, extra): relevant = ["svc/operationId", "~svc/operationId" (grade 1)] */
function P(category, lang, query, rel, extra = {}) {
  const n = (counters[category] = (counters[category] ?? 0) + 1);
  const relevant = rel.map((r) => {
    const id = r.replace(/^~/, '');
    const key = keyOf.get(id);
    if (!key) throw new Error(`unknown operation label ${id}`);
    return { service: id.split('/')[0], operation: key, grade: r.startsWith('~') ? 1 : 2 };
  });
  rows.push({ id: `d2-${category}-${String(n).padStart(2, '0')}`, batch: 'dev2-1', category, lang, query, ...extra, relevant });
}
const svc = (s) => (...x) => x.map((i) => (i.startsWith('~') ? `~${s}/${i.slice(1)}` : `${s}/${i}`));
const HR = svc('hr');
const MD = svc('media');
const W = { weak: true };

// exact_path
P('exact_path', 'en', '/leave/requests/{requestId}/approve', HR('approveLeaveRequest'));
P('exact_path', 'en', 'POST /attendance/check-in', HR('checkIn'));
P('exact_path', 'en', '/payroll/{month}/employees/{employeeId}', HR('getPayslip'));
P('exact_path', 'en', '/videos/{videoId}/renditions', MD('listRenditions'));
P('exact_path', 'en', 'GET /analytics/audience', MD('getAudienceAnalytics'));
P('exact_path', 'en', '/live/streams/{streamId}/stop', MD('stopLiveStream'));
P('exact_path', 'en', '/podcasts/{podcastId}/episodes', MD('listEpisodes', 'publishEpisode'));
P('exact_path', 'en', 'PUT /playlists/{playlistId}/items', MD('setPlaylistItems'));
// exact_operation_id
for (const id of ['approveLeaveRequest', 'getPayslip', 'scheduleInterview', 'startTranscode', 'getTranscodeJob', 'registerMediaWebhook', 'getLeaveBalance', 'resolveFlag']) P('exact_operation_id', 'en', id, id.endsWith('Webhook') || ['startTranscode', 'getTranscodeJob', 'resolveFlag'].includes(id) ? MD(id) : HR(id));
// typo
P('typo', 'en', 'aprove leave request', HR('approveLeaveRequest'));
P('typo', 'en', 'paylsip', HR('getPayslip'), W);
P('typo', 'en', 'transocde video', MD('startTranscode'));
P('typo', 'en', 'subscibe channel', MD('subscribeChannel'));
P('typo', 'en', 'add captoin', MD('addCaption'));
P('typo', 'en', 'headcuont report', HR('getHeadcountReport'));
P('typo', 'en', 'recomendations', MD('getRecommendations'), W);
P('typo', 'en', 'playlst items', MD('setPlaylistItems'));
P('typo', 'en', 'attendnce', HR('getAttendance'), W);
P('typo', 'en', 'candidtes', HR('listCandidates'), W);
// acronym (single token, weak evidence)
P('acronym', 'en', 'KPI score', HR('getPerformanceReview', 'submitPerformanceReview'), W);
P('acronym', 'vi', 'BHXH', HR('getInsurance'), W);
P('acronym', 'vi', 'CV', HR('listCandidates'), W);
P('acronym', 'vi', 'OT', HR('createOvertimeRequest'), W);
P('acronym', 'en', 'WebVTT', MD('addCaption'), W);
P('acronym', 'en', 'HLS', MD('listRenditions'), W);
P('acronym', 'en', 'RTMP', MD('startLiveStream'), W);
P('acronym', 'en', 'CDN egress', MD('getBillingUsage'), W);
// vi
P('vi', 'vi', 'xin nghỉ phép', HR('createLeaveRequest'));
P('vi', 'vi', 'bảng lương theo tháng', HR('getPayroll'));
P('vi', 'vi', 'đặt lịch phỏng vấn', HR('scheduleInterview'));
P('vi', 'vi', 'số ngày phép còn lại', HR('getLeaveBalance'));
P('vi', 'vi', 'chấm công vào', HR('checkIn'));
P('vi', 'vi', 'đăng ký làm thêm giờ', HR('createOvertimeRequest'));
P('vi', 'vi', 'phiếu lương', HR('getPayslip'));
P('vi', 'vi', 'hợp đồng lao động', HR('listContracts', 'createContract'));
P('vi', 'vi', 'chấm công', HR('getAttendance', 'checkIn', 'checkOut'), W);
P('vi', 'vi', 'lương', HR('getPayroll', 'getPayslip', 'runPayroll'), W);
P('vi', 'vi', 'tuyển dụng', HR('listJobPostings', 'createJobPosting'), W);
// vi_no_diacritics
P('vi_no_diacritics', 'vi', 'duyet don nghi phep', HR('approveLeaveRequest'));
P('vi_no_diacritics', 'vi', 'tu choi don nghi phep', HR('rejectLeaveRequest'));
P('vi_no_diacritics', 'vi', 'danh sach phong ban', HR('listDepartments'));
P('vi_no_diacritics', 'vi', 'tin tuyen dung', HR('listJobPostings', 'createJobPosting'));
P('vi_no_diacritics', 'vi', 'khoa dao tao', HR('listCourses'));
P('vi_no_diacritics', 'vi', 'danh gia hieu suat', HR('getPerformanceReview', 'submitPerformanceReview'));
P('vi_no_diacritics', 'vi', 'chuc vu', HR('listPositions'));
P('vi_no_diacritics', 'vi', 'ngay nghi le', HR('listHolidays'));
P('vi_no_diacritics', 'vi', 'cham cong', HR('getAttendance', 'checkIn', 'checkOut'), W);
P('vi_no_diacritics', 'vi', 'phong ban', HR('listDepartments', 'createDepartment', 'listDepartmentMembers'), W);
P('vi_no_diacritics', 'vi', 'luong', HR('getPayroll', 'getPayslip', 'runPayroll'), W);
// en
P('en', 'en', 'upload a video', MD('uploadVideo'));
P('en', 'en', 'list playlists', MD('listPlaylists'));
P('en', 'en', 'start a live stream', MD('startLiveStream'));
P('en', 'en', 'watch history of a user', MD('getWatchHistory'));
P('en', 'en', 'moderation flags', MD('listModerationFlags', '~resolveFlag'));
P('en', 'en', 'subscriber count of a channel', MD('getChannel'));
P('en', 'en', 'billing usage', MD('getBillingUsage'));
P('en', 'en', 'publish a podcast episode', MD('publishEpisode'));
P('en', 'en', 'transcode', MD('startTranscode', 'getTranscodeJob'), W);
P('en', 'en', 'captions', MD('listCaptions', 'addCaption'), W);
P('en', 'en', 'playlist', MD('listPlaylists', 'createPlaylist', 'setPlaylistItems', 'getPlaylist'), W);
// cjk
P('cjk', 'zh', '获取用户', ['cjk/getUserCn']);
P('cjk', 'zh', '订单状态', ['cjk/listOrdersCn']);
P('cjk', 'zh', '支付渠道', ['cjk/createPaymentCn']);
P('cjk', 'zh', '昵称', ['cjk/getUserCn'], W);
P('cjk', 'zh', '库存', ['cjk/getInventoryCn'], W);
P('cjk', 'ja', '商品', ['cjk/listProductsJa', 'cjk/getProductJa'], W);
P('cjk', 'ja', '配送', ['cjk/getShipmentJa'], W);
P('cjk', 'ja', 'ガード設定', ['cjk/getGuardsJa']);
P('cjk', 'ja', 'カード一覧', ['cjk/listCardsJa']);
// paraphrase_no_alias (no word of any alias group)
P('paraphrase_no_alias', 'en', 'vacation request', HR('createLeaveRequest'));
P('paraphrase_no_alias', 'en', 'pay stub', HR('getPayslip'));
P('paraphrase_no_alias', 'en', 'new hire paperwork', HR('createContract'));
P('paraphrase_no_alias', 'en', 'who sits in a division', HR('listDepartmentMembers'));
P('paraphrase_no_alias', 'en', 'put a movie online', MD('uploadVideo'));
P('paraphrase_no_alias', 'en', 'transcript track for a recording', MD('listCaptions'));
P('paraphrase_no_alias', 'en', 'how many people view my content', MD('getViewAnalytics'));
P('paraphrase_no_alias', 'en', 'sign up to a channel', MD('subscribeChannel'));
// paraphrase_alias (answerable through the config aliases)
const A = { requiresAlias: true };
P('paraphrase_alias', 'en', 'time off balance', HR('getLeaveBalance'), A);
P('paraphrase_alias', 'en', 'salary for a month', HR('getPayroll'), A);
P('paraphrase_alias', 'en', 'clip details', MD('getVideo'), A);
P('paraphrase_alias', 'en', 'subtitle list', MD('listCaptions'), A);
P('paraphrase_alias', 'en', 'follow a channel', MD('subscribeChannel'), A);
P('paraphrase_alias', 'en', 'staff list', HR('listEmployees'), A);
P('paraphrase_alias', 'en', 'team members', HR('listDepartmentMembers'), A);
P('paraphrase_alias', 'en', 'new agreement', HR('createContract'), A);
// response_field (responseField scope)
const RF = { fields: ['responseField'] };
P('response_field', 'en', 'remainingDays', HR('getLeaveBalance'), RF);
P('response_field', 'en', 'netSalary', HR('getPayroll'), RF);
P('response_field', 'en', 'checkInTime', HR('getAttendance'), RF);
P('response_field', 'en', 'subscriberCount', MD('getChannel'), RF);
P('response_field', 'en', 'streamKey', MD('startLiveStream'), RF);
P('response_field', 'en', 'progressPercent', MD('getTranscodeJob'), RF);
P('response_field', 'en', 'watchTimeSeconds', MD('getViewAnalytics'), RF);
P('response_field', 'en', 'officeAddress', HR('listOffices'), RF);
P('response_field', 'en', 'kpiScore', HR('getPerformanceReview'), { ...RF, bothDirections: true });
P('response_field', 'en', 'kpiScore', HR('submitPerformanceReview'), { fields: ['requestField'], bothDirections: true });
P('response_field', 'en', 'remaining', HR('getLeaveBalance'), { ...RF, ...W });
P('response_field', 'en', 'subscriber', MD('getChannel'), { ...RF, ...W });
P('response_field', 'en', 'stream key', MD('startLiveStream'), { ...RF, ...W });
// nested_schema
P('nested_schema', 'en', 'sizeBytes', MD('getTranscodeJob'), RF);
P('nested_schema', 'en', 'gigabytes', MD('getBillingUsage'), { ...RF, ...W });
P('nested_schema', 'en', 'personalIncomeTax', HR('getPayslip'), RF);
P('nested_schema', 'en', 'weight', HR('getPerformanceReview'), RF);
P('nested_schema', 'en', 'interviewer', HR('scheduleInterview'), { fields: ['requestField'], ...W });
P('nested_schema', 'en', 'webvttBody', MD('addCaption'), { fields: ['requestField'] });
P('nested_schema', 'en', 'overtimeHours', HR('createOvertimeRequest'), { fields: ['requestField'] });
P('nested_schema', 'en', 'ingestProtocol', MD('startLiveStream'), { fields: ['requestField'] });
// multi_service
P('multi_service', 'en', '/health', ['shop/getHealth', 'hr/getHrHealth', 'media/getMediaHealth']);
P('multi_service', 'en', 'health check', ['hr/getHrHealth'], { service: 'hr' });
P('multi_service', 'en', 'GET /health', ['media/getMediaHealth'], { service: 'media' });
P('multi_service', 'en', 'get employee', ['shop/getEmployee', 'hr/getEmployee']);
P('multi_service', 'vi', 'thông tin nhân viên', ['hr/getEmployee'], { service: 'hr' });
P('multi_service', 'en', '/employees/{employeeId}', ['shop/getEmployee', 'hr/getEmployee', 'hr/updateEmployee', 'hr/terminateEmployee']);
P('multi_service', 'en', 'contacts of a customer', ['crm-a/listContacts', 'crm-b/listContacts']);
P('multi_service', 'en', 'support tickets', ['crm-b/listTickets', '~crm-b/createTicket'], { service: 'crm-b' });

// D3: no_result. class = why it is hard; absentConcept is checked against every spec text by the validator
const N = (cls, lang, query, absentConcept, extra = {}) => {
  const n = (counters.no_result = (counters.no_result ?? 0) + 1);
  rows.push({ id: `d2-no_result-${String(n).padStart(2, '0')}`, batch: 'dev2-1', category: 'no_result', lang, query, ...extra, relevant: [], class: cls, absentConcept });
};
// out-of-domain
N('out-of-domain', 'en', 'weather forecast for tomorrow', 'weather');
N('out-of-domain', 'en', 'book a flight to Hanoi', 'flight');
N('out-of-domain', 'en', 'translate this sentence to French', 'translate');
N('out-of-domain', 'en', 'bitcoin price', 'bitcoin');
N('out-of-domain', 'en', 'recipe for chicken soup', 'recipe');
N('out-of-domain', 'vi', 'thông tin sao chổi', 'sao choi');
N('out-of-domain', 'vi', 'giá vàng hôm nay', 'gia vang');
N('out-of-domain', 'vi', 'đặt vé xem phim', 'xem phim');
N('out-of-domain', 'zh', '航班预订', '航班');
N('out-of-domain', 'zh', '天气预报', '天气');
N('out-of-domain', 'ja', '飛行機の予約', '飛行機');
N('out-of-domain', 'ko', '달 탐사선', '탐사선');
// shares function words / common words with spec text, names an absent concept
N('function-word-overlap', 'en', 'list of all the planets', 'planets');
N('function-word-overlap', 'en', 'get the current moon phase', 'moon');
N('function-word-overlap', 'en', 'create a new galaxy', 'galaxy');
N('function-word-overlap', 'en', 'update the tide table', 'tide');
N('function-word-overlap', 'en', 'delete my dentist appointment', 'dentist');
N('function-word-overlap', 'en', 'send a postcard to my aunt', 'postcard');
N('function-word-overlap', 'en', 'read the horoscope for the day', 'horoscope');
N('function-word-overlap', 'en', 'cancel my gym membership', 'gym');
N('function-word-overlap', 'vi', 'xem danh sách các hành tinh', 'hanh tinh');
// typo-distance neighbour of a spec word, absent concept
N('fuzzy-neighbour', 'en', 'show my ordeal history', 'ordeal');
N('fuzzy-neighbour', 'en', 'consult the oracle', 'oracle');
N('fuzzy-neighbour', 'en', 'supply chain overview', 'supply');
N('fuzzy-neighbour', 'en', 'customs clearance', 'customs');
N('fuzzy-neighbour', 'en', 'shipyard schedule', 'shipyard');
N('fuzzy-neighbour', 'en', 'wharf berths', 'wharf');
N('fuzzy-neighbour', 'en', 'refrain of a song', 'refrain');
N('fuzzy-neighbour', 'en', 'pavement repair', 'pavement');
N('fuzzy-neighbour', 'en', 'catalan grammar', 'catalan');
// Vietnamese without diacritics that collides with other syllables of the specs
N('diacritic-collision', 'vi', 'cua hang vang bac', 'vang bac');
N('diacritic-collision', 'vi', 'ban do du lich', 'ban do');
N('diacritic-collision', 'vi', 'hang khong gia re', 'hang khong');
N('diacritic-collision', 'vi', 'thue xe may', 'xe may');
N('diacritic-collision', 'vi', 'bao hiem xe', 'bao hiem xe');
N('diacritic-collision', 'vi', 'nha hang buffet', 'nha hang');
N('diacritic-collision', 'vi', 'don dep nha cua', 'don dep');
N('diacritic-collision', 'vi', 'tin tuc the thao', 'the thao');
// CJK query sharing one character with spec text
N('cjk-single-char', 'zh', '订票', '订票');
N('cjk-single-char', 'zh', '单词', '单词');
N('cjk-single-char', 'zh', '户外', '户外');
N('cjk-single-char', 'zh', '付费电影', '电影');
N('cjk-single-char', 'zh', '退休', '退休');
N('cjk-single-char', 'zh', '商店', '商店');
// a REAL field asked in the wrong direction (verified from the specs by the validator)
N('scope-mismatch', 'en', 'callbackUrl', 'callbackUrl', { fields: ['responseField'], scopeMismatch: true });
N('scope-mismatch', 'en', 'couponCode', 'couponCode', { fields: ['responseField'], scopeMismatch: true });
N('scope-mismatch', 'en', 'cardToken', 'cardToken', { fields: ['responseField'], scopeMismatch: true });
N('scope-mismatch', 'en', 'overtimeHours', 'overtimeHours', { fields: ['responseField'], scopeMismatch: true });
N('scope-mismatch', 'en', 'remainingDays', 'remainingDays', { fields: ['requestField'], scopeMismatch: true });
N('scope-mismatch', 'en', 'streamKey', 'streamKey', { fields: ['requestField'], scopeMismatch: true });
N('scope-mismatch', 'en', 'netSalary', 'netSalary', { fields: ['requestField'], scopeMismatch: true });
N('scope-mismatch', 'en', 'subscriberCount', 'subscriberCount', { fields: ['requestField'], scopeMismatch: true });
// sounds like a spec concept, absent
N('sounds-like-absent', 'en', 'pension fund', 'pension');
N('sounds-like-absent', 'en', 'tax return filing', 'tax return');
N('sounds-like-absent', 'en', 'severance package', 'severance');
N('sounds-like-absent', 'en', 'stock options', 'stock option');
N('sounds-like-absent', 'en', 'video game', 'video game');
N('sounds-like-absent', 'en', 'radio station', 'radio');
N('sounds-like-absent', 'en', 'newsletter subscription', 'newsletter');
// unprocessable input (correct outcome is QUERY_UNPROCESSABLE)
for (const q of ['🙂', '???', '--- ///', '🔥🔥', '...']) N('unprocessable', 'mixed', q, 'zzqx');

const weak = rows.filter((r) => r.weak === true).length;
if (weak < 30) throw new Error(`D2 needs at least 30 weak-evidence positives, found ${weak}`);
fs.writeFileSync(path.join(out, 'queries.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
console.log(`wrote dev2: ${rows.length} queries (${weak} weak), ${Object.keys(config.services).length} services`);
