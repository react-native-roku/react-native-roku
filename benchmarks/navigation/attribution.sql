SELECT s.id, s.ts, s.dur, s.parent_id, s.name,
       COALESCE(thread.name, track.name) AS track,
       EXTRACT_ARG(s.arg_set_id, 'debug.key') AS key,
       EXTRACT_ARG(s.arg_set_id, 'debug.isKeyPress') AS press,
       EXTRACT_ARG(s.arg_set_id, 'debug.function') AS callback,
       EXTRACT_ARG(s.arg_set_id, 'debug.event') AS marker,
       EXTRACT_ARG(s.arg_set_id, 'debug.input') AS input,
       EXTRACT_ARG(s.arg_set_id, 'debug.card') AS card,
       EXTRACT_ARG(s.arg_set_id, 'debug.phases') AS phases,
       EXTRACT_ARG(s.arg_set_id, 'debug.count') AS count,
       EXTRACT_ARG(s.arg_set_id, 'debug.target') AS target,
       EXTRACT_ARG(s.arg_set_id, 'debug.reuse') AS reuse,
       EXTRACT_ARG(s.arg_set_id, 'debug.sparse') AS sparse,
       EXTRACT_ARG(s.arg_set_id, 'debug.jsMs') AS jsMs,
       EXTRACT_ARG(s.arg_set_id, 'debug.field') AS field,
       EXTRACT_ARG(s.arg_set_id, 'debug.data') AS value,
       (SELECT MAX(a.id) FROM ancestor_slice(s.id) a WHERE a.name = 'consumeAllTasks') AS apply_id,
       (SELECT f.slice_out FROM flow f WHERE f.slice_in = s.id ORDER BY f.id LIMIT 1) AS flow_from,
       (SELECT COUNT(*) FROM descendant_slice(s.id) d WHERE d.name = 'Print') AS prints
FROM slice s
JOIN track ON track.id = s.track_id
LEFT JOIN thread_track ON thread_track.id = track.id
LEFT JOIN thread ON thread.utid = thread_track.utid
WHERE s.name IN ('keyEvent', 'observer.callback', 'consumeAllTasks', 'transaction.start',
                 'transaction.commit', 'transaction.update', 'transaction.end',
                 'transaction.toTS.commit', 'render', 'swapBuffers', 'shelf.mark')
ORDER BY s.ts, s.id;
