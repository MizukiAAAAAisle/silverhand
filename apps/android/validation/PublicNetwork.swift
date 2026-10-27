import Foundation
import FoundationNetworking
import SilverhandNative
@main struct NetworkCheck {
 static func main() async {
  let transport = NativeTransport()
  do {
   let response = try await transport.fetch(URLRequest(url:URL(string:"https://postman-echo.com/get?probe=silverhand-stage1")!))
   guard response.status == 200 else { throw NSError(domain:"HTTP",code:response.status) }
   print("PASS public HTTPS status=200")
   let socket=transport.session.webSocketTask(with:URL(string:"wss://ws.postman-echo.com/raw")!)
   socket.resume()
   try await socket.send(.string("silverhand-stage1-public-ca"))
   let reply=try await socket.receive()
   guard case .string(let text)=reply,text=="silverhand-stage1-public-ca" else { throw NSError(domain:"WSS echo",code:1) }
   print("PASS public WSS exact echo")
   socket.cancel(with:.normalClosure,reason:nil)
   transport.session.invalidateAndCancel()
  } catch { print("FAIL public network: \(error)"); exit(1) }
 }
}
