SELECT s.id, s.ts, s.dur, s.parent_id, s.name,
       COALESCE(thread.name, track.name) AS track,
       EXTRACT_ARG(s.arg_set_id, 'debug.name') AS field,
       (SELECT slice_out FROM flow f WHERE f.slice_in = s.id ORDER BY f.id LIMIT 1) AS flow_from
FROM slice s
JOIN track ON track.id=s.track_id
LEFT JOIN thread_track ON track.id = thread_track.id
LEFT JOIN thread ON thread_track.utid = thread.utid
WHERE s.name LIKE 'transaction.toTS.%' OR
      (s.name = 'roSGNode.setField' AND EXTRACT_ARG(s.arg_set_id, 'debug.name')='keyEvent')
ORDER BY s.ts, s.id;
