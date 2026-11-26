sub onRequest()
    if m.task = invalid
        m.task = CreateObject("roSGNode", "RNRTextRasterTask")
        m.task.namespace = m.top.namespace
        m.task.observeField("reply", "onReply")
        m.task.command = m.top.request
        m.task.control = "RUN"
    else
        m.task.command = m.top.request
    end if
end sub

sub onReply()
    m.top.reply = m.task.reply
end sub
