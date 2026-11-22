from fastapi import HTTPException
from pymysql import IntegrityError

from .lanes import lock_booking, lock_task, slot_load
from .storage import audit


def list_switches(cur, floor):
    cur.execute('SELECT w.id,w.booking_id,w.task_id,w.slot_start,w.seats,w.status,w.created_at,w.confirmed_at,'
                'w.from_lane_id,w.to_lane_id,fl.name AS from_lane,tl.name AS to_lane,'
                'fl.capacity AS from_capacity,tl.capacity AS to_capacity,t.handled_by,s.name AS anchor,'
                "(SELECT COALESCE(SUM(b.seats),0) FROM lane_bookings b WHERE b.lane_id=w.from_lane_id "
                "AND b.slot_start=w.slot_start AND b.status IN ('booked','in_use')) + "
                "(SELECT COALESCE(SUM(x.seats),0) FROM lane_switches x WHERE x.to_lane_id=w.from_lane_id "
                "AND x.slot_start=w.slot_start AND x.status='pending') AS from_load,"
                "(SELECT COALESCE(SUM(b.seats),0) FROM lane_bookings b WHERE b.lane_id=w.to_lane_id "
                "AND b.slot_start=w.slot_start AND b.status IN ('booked','in_use')) + "
                "(SELECT COALESCE(SUM(x.seats),0) FROM lane_switches x WHERE x.to_lane_id=w.to_lane_id "
                "AND x.slot_start=w.slot_start AND x.status='pending') AS to_load "
                'FROM lane_switches w JOIN queue_lanes fl ON fl.id=w.from_lane_id '
                'JOIN queue_lanes tl ON tl.id=w.to_lane_id JOIN dispatch_tasks t ON t.id=w.task_id '
                'JOIN hotspots h ON h.id=t.hotspot_id JOIN stores s ON s.id=h.anchor_store_id '
                "WHERE fl.floor=%s ORDER BY (w.status='pending') DESC,w.id DESC", (floor,))
    return cur.fetchall()


def initiate(cur, key, to_lane_id, actor):
    booking, task = lock_booking(cur, key)
    if booking['status'] != 'in_use':
        raise HTTPException(409, '仅使用中的等候线预留可发起换线')
    cur.execute('SELECT f.floor FROM floor_hours f JOIN hotspots h ON h.hour_id=f.id WHERE h.id=%s',
                (task['hotspot_id'],))
    floor = cur.fetchone()['floor']
    cur.execute('SELECT * FROM queue_lanes WHERE id=%s FOR UPDATE', (to_lane_id,))
    lane = cur.fetchone()
    if not lane or lane['floor'] != floor:
        raise HTTPException(422, '目标等候线须位于疏导任务所在楼层')
    if lane['id'] == booking['lane_id']:
        raise HTTPException(422, '目标等候线须为同层另一条线')
    remaining = lane['capacity'] - slot_load(cur, lane['id'], booking['slot_start'])
    if booking['seats'] > remaining:
        raise HTTPException(409, f'目标等候线该时段仅余 {remaining} 个名额，原预留照常使用')
    try:
        cur.execute('INSERT INTO lane_switches(booking_id,task_id,from_lane_id,to_lane_id,slot_start,seats,requested_by) '
                    'VALUES(%s,%s,%s,%s,%s,%s,%s)',
                    (key, booking['task_id'], booking['lane_id'], lane['id'], booking['slot_start'], booking['seats'], actor))
    except IntegrityError as error:
        if error.args[0] != 1062:
            raise
        raise HTTPException(409, '该预留已有进行中的换线') from None
    switch_id = cur.lastrowid
    audit(cur, actor, 'lane.switch_requested', switch_id)
    return {'id': switch_id, 'status': 'pending'}


def confirm(cur, key, actor):
    cur.execute('SELECT task_id FROM lane_switches WHERE id=%s', (key,))
    reference = cur.fetchone()
    if not reference:
        raise HTTPException(404, '换线记录不存在')
    task = lock_task(cur, reference['task_id'])
    cur.execute('SELECT * FROM lane_switches WHERE id=%s FOR UPDATE', (key,))
    switch = cur.fetchone()
    if task['handled_by'] != actor:
        raise HTTPException(403, '仅认领该疏导单的现场人员可确认转完')
    if switch['status'] == 'confirmed':
        return {'id': key, 'status': 'confirmed', 'duplicate': True}
    cur.execute('SELECT status FROM lane_bookings WHERE id=%s FOR UPDATE', (switch['booking_id'],))
    if cur.fetchone()['status'] != 'in_use':
        raise HTTPException(409, '原预留状态已变化，无法完成换线')
    cur.execute("UPDATE lane_switches SET status='confirmed',confirmed_by=%s,confirmed_at=NOW() WHERE id=%s", (actor, key))
    cur.execute('UPDATE lane_bookings SET lane_id=%s WHERE id=%s', (switch['to_lane_id'], switch['booking_id']))
    audit(cur, actor, 'lane.switch_confirmed', key)
    return {'id': key, 'status': 'confirmed', 'duplicate': False}
