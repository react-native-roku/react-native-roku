sub Main()
 screen=CreateObject("roSGScreen")
 port=CreateObject("roMessagePort")
 screen.setMessagePort(port)
 scene=screen.CreateScene("NativeShelfScene")
 screen.show()
 while true
  message=wait(0,port)
  if type(message)="roSGScreenEvent" and message.isScreenClosed() then return
 end while
end sub

