import {api, state} from '../state.js';
import {badge, empty, header, input, readForm, stamp, text} from '../ui.js';

const labels = {booked: '已预留', in_use: '使用中', released: '已释放', cancelled: '已取消'};
const switchLabels = {pending: '换线中', confirmed: '已转完'};

function eligibleSlots(task) {
  if (!task) return '';
  const hour = Date.parse(`${task.hour_start.slice(0, 16)}Z`);
  return Array.from({length: 8}, (_, index) => {
    const time = new Date(hour + (60 + 15 * index) * 60000).toISOString().slice(0, 16);
    return `<option value="${time}">${stamp(time)}</option>`;
  }).join('');
}

function bookingForm(lanes, tasks) {
  const preferred = tasks.find(task => task.id === state.bookingTask) || tasks[0];
  return `<h2>预留等候线</h2>${preferred && lanes.length ? `<form class="stack" id="book-line">
    <label>疏导任务<select name="task_id">${tasks.map(task => `<option value="${task.id}" ${preferred.id === task.id ? 'selected' : ''}>#${task.id} · ${text(task.anchor)} · ${stamp(task.hour_start)}</option>`).join('')}</select></label>
    <label>等候线<select name="lane_id">${lanes.map(lane => `<option value="${lane.id}">${text(lane.name)} · ${lane.capacity} 人</option>`).join('')}</select></label>
    <label>15 分钟时段<select name="slot_start">${eligibleSlots(preferred)}</select></label>
    ${input('预留人数', 'seats', 'number', 'required min="1" max="150"')}
    <p class="minor" id="capacity-hint"></p><button>提交预留</button></form>` : empty('需要该楼层有可安排的疏导任务和等候线。')}
    <details class="line-config"><summary>登记等候线</summary><form class="stack" id="create-line">
    ${input('等候线名称', 'name', 'text', 'required minlength="2" maxlength="60"')}
    ${input('每时段容量', 'capacity', 'number', 'required min="1" max="150"')}<button>保存等候线</button></form></details>`;
}

function bookingCard(booking, user, lanes, pendingSwitch) {
  const owns = user.role === 'steward' && booking.handled_by === user.id;
  const alternatives = lanes.filter(lane => lane.id !== booking.lane_id);
  return `<article class="lane-record" data-booking="${booking.id}"><div class="section-line"><div>
    <h3>${text(booking.lane_name)}</h3><p class="minor">${stamp(booking.slot_start)} · 疏导 #${booking.task_id} · ${text(booking.anchor)}</p></div>
    ${badge(labels[booking.status], booking.status === 'released' ? 'good' : 'warm')}</div>
    <div class="allocation-readout"><strong>${booking.seats} 人预留</strong><span>该时段占用 ${booking.occupied} / ${booking.capacity} 人</span>
      ${booking.moved_count != null ? `<strong>实际入线 ${booking.moved_count} 人</strong>` : ''}</div>
    ${owns && booking.status === 'booked' && booking.task_status === 'active' ? `<form class="stack" data-use="${booking.id}">
      ${input('实际入线人数', 'moved_count', 'number', `required min="1" max="${booking.seats}"`)}<button>登记入线</button></form>` : ''}
    ${owns && booking.status === 'in_use' && !pendingSwitch ? `<button data-end="${booking.id}" data-action="release">释放等候线</button>` : ''}
    ${owns && booking.status === 'in_use' && pendingSwitch ? '<p class="minor">换线确认中，转完前不能释放原预留。</p>' : ''}
    ${user.role === 'operator' && booking.status === 'in_use' && !pendingSwitch && alternatives.length ?`<details class="line-config switch-form"><summary>临时封路 · 发起换线</summary><form class="stack" data-switch="${booking.id}">
      <label>换到等候线<select name="to_lane_id">${alternatives.map(lane => `<option value="${lane.id}">${text(lane.name)} · ${lane.capacity} 人</option>`).join('')}</select></label>
      <button>先留名额并发起换线</button></form></details>` : ''}
    ${user.role === 'operator' && booking.status === 'booked' ? `<button class="secondary" data-end="${booking.id}" data-action="cancel">取消预留</button>` : ''}</article>`;
}

function switchCard(row, user) {
  const owns = user.role === 'steward' && row.handled_by === user.id;
  return `<article class="lane-record" data-switch-id="${row.id}"><div class="section-line"><div>
    <h3>${text(row.from_lane)} → ${text(row.to_lane)}</h3><p class="minor">${stamp(row.slot_start)} 时段 · 疏导 #${row.task_id} · ${text(row.anchor)}</p></div>
    ${badge(switchLabels[row.status], row.status === 'confirmed' ? 'good' : 'warm')}</div>
    <div class="allocation-readout"><strong>${row.seats} 人转线</strong>
      <span>原线该时段余 ${row.from_capacity - row.from_load} / ${row.from_capacity} 人</span>
      <span>新线该时段余 ${row.to_capacity - row.to_load} / ${row.to_capacity} 人</span></div>
    ${row.status === 'pending' && owns ? `<button data-confirm-switch="${row.id}">确认全部转完</button>` : ''}
    ${row.status === 'pending' && !owns ? '<p class="minor">等待现场确认全部转完，原线名额仍占用中。</p>' : ''}</article>`;
}

export async function lanes() {
  const query = `floor=${state.floor}`;
  const [lanes, bookings, switches, allTasks] = await Promise.all([api(`/lanes?${query}`), api(`/lane-bookings?${query}`), api(`/lane-switches?${query}`), api(`/tasks?${query}`)]);
  const user = state.session.user;
  const blocked = new Set(bookings.filter(item => item.status !== 'cancelled').map(item => item.task_id));
  const tasks = allTasks.filter(task => task.status !== 'closed' && !blocked.has(task.id));
  const switchByBooking = new Map(switches.filter(item => item.status === 'pending').map(item => [item.booking_id, item]));
  return {
    html: `${header('现场容量', '等候线容量排班', '按 15 分钟预留临时等候线。同一时段共用容量，现场登记实入人数并释放后才能结案；临时封路可发起换线，现场确认转完后原线名额才释放。')}
      <div class="split"><section class="panel"><div class="section-line"><h2>预留与实到台账</h2><a href="#tasks">返回客流疏导</a></div>
      ${lanes.length ? `<ul class="known-lines">${lanes.map(lane => `<li>${text(lane.name)} <b>${lane.capacity} 人 / 时段</b></li>`).join('')}</ul>` : ''}
      ${bookings.length ? bookings.map(item => bookingCard(item, user, lanes, switchByBooking.get(item.id))).join('') : empty('该楼层暂无等候线预留。')}
      <h2 class="under">换线记录</h2>
      ${switches.length ? switches.map(item => switchCard(item, user)).join('') : empty('该楼层暂无换线记录。')}</section>
      ${user.role === 'operator' ? `<aside class="side-note">${bookingForm(lanes, tasks)}</aside>` : ''}</div>`,
    bind(root, action) {
      const start = root.querySelector('#book-line');
      if (start) {
        const fields = start.elements;
        const hint = () => {
          const lane = lanes.find(item => String(item.id) === fields.lane_id.value);
          const match = bookings.find(item => item.lane_id === lane.id && item.slot_start.slice(0,16) === fields.slot_start.value);
          start.querySelector('#capacity-hint').textContent = `该时段占用 ${match?.occupied ?? 0} / ${lane.capacity} 人`;
        };
        fields.task_id.onchange = () => {
          fields.slot_start.innerHTML = eligibleSlots(tasks.find(task => String(task.id) === fields.task_id.value));
          hint();
        };
        fields.lane_id.onchange = fields.slot_start.onchange = hint;
        hint();
        start.onsubmit = event => { event.preventDefault(); action(() => api('/lane-bookings', readForm(start)), '等候线已预留', start); };
      }
      const create = root.querySelector('#create-line');
      if (create) create.onsubmit = event => {
        event.preventDefault();
        action(() => api('/lanes', {...readForm(create), floor: state.floor}), '等候线已登记', create);
      };
      root.querySelectorAll('[data-use]').forEach(form => {
        form.onsubmit = event => { event.preventDefault(); action(() => api(`/lane-bookings/${form.dataset.use}/use`, readForm(form)), '使用已登记', form); };
      });
      root.querySelectorAll('[data-end]').forEach(button => {
        button.onclick = () => action(() => api(`/lane-bookings/${button.dataset.end}/end`, {action: button.dataset.action}), '预留已更新', button);
      });
      root.querySelectorAll('[data-switch]').forEach(form => {
        form.onsubmit = event => { event.preventDefault(); action(() => api(`/lane-bookings/${form.dataset.switch}/switch`, readForm(form)), '换线已发起，等待现场确认转完', form); };
      });
      root.querySelectorAll('[data-confirm-switch]').forEach(button => {
        button.onclick = () => action(() => api(`/lane-switches/${button.dataset.confirmSwitch}/confirm`, {}), '换线已确认，原线名额已释放', button);
      });
    },
  };
}
