import mqtt, { MqttClient } from 'mqtt';
import { Machine, Log } from '../modules/machine/machine.model';
import Payment from '../modules/payment/payment.model';

class MQTTHandler {
  public client: MqttClient | null = null;
  public isConnected: boolean = false;
  private machineSessions: Map<string, any> = new Map();

  constructor() {
    this.client = null;
    this.isConnected = false;
    this.machineSessions = new Map();
  }

  public connect(): void {
    const brokerUrl = process.env.MQTT_BROKER_URL || 'mqtt://broker.hivemq.com';
    
    this.client = mqtt.connect(brokerUrl, {
      clientId: `backend_${Date.now()}`,
      keepalive: 60,
      reconnectPeriod: 5000
    });

    this.client.on('connect', () => {
      console.log('✅ MQTT Connected to broker');
      this.isConnected = true;
      
      this.client?.subscribe('freshpod_vending_2025/+/response', (err) => {
        if (!err) console.log('Subscribed to machine responses');
      });
    });

    this.client.on('error', (err) => {
      console.error('MQTT Error:', err);
      this.isConnected = false;
    });

    this.client.on('message', (topic, message) => {
      this.handleMachineResponse(topic, message);
    });
  }

  private async handleMachineResponse(topic: string, message: Buffer): Promise<void> {
    try {
      const data = JSON.parse(message.toString());
      const machineId = topic.split('/')[1];
      
      console.log(`📨 Machine response from ${machineId}:`, data);
      
      const machine = await Machine.findOne({ machineId });
      if (!machine) return;
      
      if (data.status === 'started') {
        console.log(`Machine ${machineId} started successfully`);
        
        await Machine.updateOne(
          { machineId },
          { 
            $set: { 
              status: 'running',
              lastStartedAt: new Date()
            }
          }
        );
        
      } else if (data.status === 'completed') {
        console.log(`Machine ${machineId} completed dispensing`);
        
        const session = this.machineSessions.get(machineId);
        const amount = session ? session.amount : machine.costPerTap || 70;
        const transactionId = session ? session.transactionId : `TXN_MQTT_${Date.now()}`;
        const customerId = session ? session.customerId : 'unknown';

        await Machine.updateOne(
          { machineId },
          { 
            $set: { status: 'idle' },
            $inc: { totalTaps: 1 }
          }
        );
        
        const today = new Date().toISOString().split('T')[0];
        await Log.findOneAndUpdate(
          { machineId, date: today },
          { 
            $inc: { tapCount: 1 },
            $set: { updatedAt: new Date() }
          },
          { upsert: true }
        );

        // Record MQTT payment transaction in MongoDB
        try {
          const payment = await Payment.create({
            paymentId: transactionId,
            machineId: machineId,
            amount: amount,
            method: 'MQTT',
            status: 'paid',
            customerName: customerId,
            customerEmail: 'N/A',
            customerPhone: 'N/A',
            timestamp: new Date()
          });
          
          if ((global as any).broadcastLiveEvent) {
            (global as any).broadcastLiveEvent('PAYMENT_UPDATE', {
              _id: payment._id.toString(),
              paymentId: transactionId,
              machineId: machineId,
              amount: amount,
              method: 'MQTT',
              status: 'paid',
              customerName: customerId,
              customerEmail: 'N/A',
              customerPhone: 'N/A',
              timestamp: payment.timestamp
            });
          }
        } catch (dbErr: any) {
          console.error('[DB] Failed to record completed MQTT payment in MongoDB:', dbErr.message);
        }

        // Clear active session
        this.machineSessions.delete(machineId);
        
      } else if (data.status === 'error') {
        console.error(`Machine ${machineId} error:`, data.message);
        
        await Machine.updateOne(
          { machineId },
          { $set: { status: 'error', lastError: data.message } }
        );
      }
      
    } catch (error) {
      console.error('Error handling MQTT response:', error);
    }
  }

  public async startMachine(machineId: string, amount: number, customerId: string): Promise<{ success: boolean; transactionId?: string; error?: string }> {
    if (!this.isConnected || !this.client) {
      console.error('MQTT not connected');
      return { success: false, error: 'MQTT service unavailable' };
    }
    
    const topic = `freshpod_vending_2025/${machineId}`;
    const transactionId = `TXN_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    
    const payload = JSON.stringify({
      command: 'start',
      amount: amount,
      transaction_id: transactionId,
      customer_id: customerId,
      timestamp: new Date().toISOString()
    });
    
    return new Promise((resolve) => {
      this.client!.publish(topic, payload, { qos: 1 }, (err) => {
        if (err) {
          console.error('Publish error:', err);
          resolve({ success: false, error: err.message });
        } else {
          console.log(`✅ Start signal sent to ${machineId}`);
          
          this.machineSessions.set(machineId, {
            startTime: new Date(),
            amount,
            transactionId,
            customerId
          });
          
          resolve({ success: true, transactionId });
        }
      });
    });
  }

  public async stopMachine(machineId: string): Promise<{ success: boolean; error?: string }> {
    if (!this.isConnected || !this.client) {
      return { success: false, error: 'MQTT service unavailable' };
    }
    
    const topic = `freshpod_vending_2025/${machineId}`;
    const payload = JSON.stringify({
      command: 'stop',
      timestamp: new Date().toISOString()
    });
    
    return new Promise((resolve) => {
      this.client!.publish(topic, payload, { qos: 1 }, (err) => {
        if (err) {
          resolve({ success: false, error: err.message });
        } else {
          console.log(`✅ Stop signal sent to ${machineId}`);
          this.machineSessions.delete(machineId);
          resolve({ success: true });
        }
      });
    });
  }
}

export default new MQTTHandler();
