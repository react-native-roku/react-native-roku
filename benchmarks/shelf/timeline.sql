SELECT
  slice.ts AS device_ts_ns,
  slice.dur AS duration_ns,
  COALESCE(thread.name, track.name) AS track,
  slice.name AS event,
  EXTRACT_ARG(slice.arg_set_id, 'debug.key') AS key,
  EXTRACT_ARG(slice.arg_set_id, 'debug.isKeyPress') AS press,
  EXTRACT_ARG(slice.arg_set_id, 'debug.component') AS component,
  EXTRACT_ARG(slice.arg_set_id, 'debug.name') AS field
FROM slice
JOIN track ON slice.track_id = track.id
LEFT JOIN thread_track ON track.id = thread_track.id
LEFT JOIN thread ON thread_track.utid = thread.utid
WHERE slice.name IN (
  'keyEvent', 'transaction.start', 'transaction.commit', 'transaction.toTS.start',
  'transaction.toTS.commit', 'transaction.end', 'roSGNode.setField',
  'render', 'swapBuffers'
)
ORDER BY slice.ts, slice.id;
