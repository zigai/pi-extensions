import dgram from "node:dgram";
import net from "node:net";

function refuseNetworkConnection() {
  throw new Error("The deterministic Pi PTY fixture forbids network connections");
}

net.Socket.prototype.connect = refuseNetworkConnection;
dgram.Socket.prototype.connect = refuseNetworkConnection;
