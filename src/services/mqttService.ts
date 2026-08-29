import mqtt, { MqttClient } from 'mqtt';
import { Machine, Log } from '../modules/machine/machine.model';
import Payment from '../modules/payment/payment.model';
import { Response } from 'express';

// ─────────────────────────────────────────────────────────────────
//  SSE CLIENT REGISTRY
//  Holds active SSE response streams from browser clients.
//  When a dashboard event fires (payment, telemetry), we write
//  directly to each open stream — no WebSocket needed.
// ─────────────────────────────────────────────────────────────────
const sseClients: Set<Response> = new Set();

export function registerSSEClient(res: Response) {
  sseClients.add(res);
}

export function unregisterSSEClient(res: Response) {
  sseClients.delete(res);
}

// ─────────────────────────────────────────────────────────────────
//  DASHBOARD MQTT TOPIC
// ─────────────────────────────────────────────────────────────────
const DASHBOARD_TOPIC = 'freshpod_vending_2025/dashboard/events';

class MQTTHandler {
  public client: MqttClient | null = null;
  public isConnected: boolean = false;
  public machineSessions: Map<string, any> = new Map();
  private onSessionCompleted: ((machineId: string) => void) | null = null;

  constructor() {
    this.client = null;
    this.isConnected = false;
    this.machineSessions = new Map();
  }

  public registerSessionCompletedCallback(cb: (machineId: string) => void) {
    this.onSessionCompleted = cb;
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

      // Subscribe to machine response topics
      this.client?.subscribe('freshpod_vending_2025/+/response', (err) => {
        if (!err) console.log('[MQTT] Subscribed to machine responses');
      });

      // Subscribe to our own dashboard event topic so we can relay to SSE
      this.client?.subscribe(DASHBOARD_TOPIC, (err) => {
        if (!err) console.log('[MQTT] Subscribed to dashboard events');
      });
    });

    this.client.on('error', (err) => {
      console.error('MQTT Error:', err);
      this.isConnected = false;
    });

    this.client.on('message', (topic, message) => {
      if (topic === DASHBOARD_TOPIC) {
        // Relay dashboard events directly to all connected SSE clients
        this.relayToSSEClients(message.toString());
      } else {
        this.handleMachineResponse(topic, message);
      }
    });
  }

  /**
   * Publish a structured dashboard event to the MQTT dashboard topic.
   * The MQTT 'message' handler above will relay it to SSE clients.
   */
  public broadcastDashboardEvent(type: string, data: any): void {
    const payload = JSON.stringify({ type, data, timestamp: Date.now() });
    if (this.isConnected && this.client) {
      this.client.publish(DASHBOARD_TOPIC, payload, { qos: 0 });
    } else {
      // Fallback: write directly to SSE clients if MQTT is temporarily down
      this.relayToSSEClients(payload);
    }
  }

  /**
   * Write an SSE data frame to every registered browser client.
   */
  private relayToSSEClients(rawJson: string): void {
    const sseFrame = `data: ${rawJson}\n\n`;
    sseClients.forEach((res) => {
      try {
        res.write(sseFrame);
      } catch (_) {
        // Client disconnected mid-write; will be cleaned up on 'close'
      }
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
        const transactionId = data.transaction_id || (session ? session.transactionId : `TXN_MQTT_${Date.now()}`);
        const amount = session ? session.amount : machine.costPerTap || 70;
        const customerId = session ? session.customerId : 'unknown';
        const method = session ? session.method || 'Operator' : 'RFID';

        // ── ALWAYS: increment tap counter and write daily log ──────────
        await Machine.updateOne(
          { machineId },
          {
            $set: { status: 'idle' },
            $inc: { totalTaps: 1 }
          }
        );

        const today = new Date().toISOString().split('T')[0];
        const log = await Log.findOneAndUpdate(
          { machineId, date: today, action: 'TAP_DISPENSED' },
          {
            $inc: { tapCount: 1 },
            $set: { updatedAt: new Date(), action: 'TAP_DISPENSED', status: 'completed' }
          },
          { upsert: true, new: true }
        );

        // ── PAYMENT RECORD: avoid duplicates for Razorpay QR payments ──
        let payment: any = null;
        try {
          const existing = await Payment.findOne({
            $or: [{ paymentId: transactionId }, { qrId: transactionId }],
            status: 'paid'
          });

          if (existing) {
            payment = existing;
            console.log(`[MQTT] Payment record already exists for ${transactionId} (Razorpay flow) — skipping duplicate`);
          } else {
            payment = await Payment.create({
              paymentId: transactionId,
              machineId: machineId,
              amount: amount,
              method: method,
              status: 'paid',
              customerName: customerId !== 'unknown' ? customerId : 'RFID Tap',
              customerEmail: 'N/A',
              customerPhone: 'N/A',
              timestamp: new Date()
            });
            console.log(`[MQTT] New payment record created for ${transactionId} (${method} flow)`);
          }

          // Broadcast via MQTT dashboard topic → SSE clients
          this.broadcastDashboardEvent('PAYMENT_UPDATE', {
            _id: payment._id.toString(),
            paymentId: transactionId,
            machineId: machineId,
            amount: payment.amount,
            method: payment.method,
            status: 'paid',
            customerName: payment.customerName,
            timestamp: payment.timestamp
          });

          this.broadcastDashboardEvent('TELEMETRY_UPDATE', {
            machineId: machineId,
            totalTaps: machine.totalTaps + 1,
            status: 'idle',
            lastTap: log
          });
        } catch (dbErr: any) {
          console.error('[DB] Failed to record completed payment in MongoDB:', dbErr.message);
        }

        // Notify session completed callback (clears operator screen loading state)
        if (this.onSessionCompleted) {
          try {
            this.onSessionCompleted(machineId);
          } catch (err: any) {
            console.error('[MQTT] Session completion callback error:', err.message);
          }
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

  /**
   * Push a real-time config update to an ESP32 over MQTT.
   * Used when admin/customer changes the QR amount from the dashboard.
   * The firmware handles this without needing an OTA reflash.
   */
  public pushConfigUpdate(machineId: string, amountINR: number): void {
    if (!this.isConnected || !this.client) {
      console.warn('[MQTT] Cannot push config update — not connected');
      return;
    }
    const topic = `freshpod_vending_2025/${machineId}/config`;
    const payload = JSON.stringify({
      command: 'update_config',
      amount: amountINR,
      timestamp: new Date().toISOString()
    });
    this.client.publish(topic, payload, { qos: 1 }, (err) => {
      if (err) {
        console.error(`[MQTT] Failed to push config to ${machineId}:`, err.message);
      } else {
        console.log(`[MQTT] Config update sent to ${machineId}: amount=₹${amountINR}`);
      }
    });
  }
}

export default new MQTTHandler();
