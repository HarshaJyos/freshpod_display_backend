import { Request, Response } from 'express';
import { Firmware } from './firmware.model';
import { v2 as cloudinary } from 'cloudinary';
import streamifier from 'streamifier';
import fs from 'fs';
import path from 'path';

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || '',
  api_key: process.env.CLOUDINARY_API_KEY || '',
  api_secret: process.env.CLOUDINARY_API_SECRET || ''
});

function incrementVersion(version: string): string {
  const parts = version.split('.').map(Number);
  if (parts.length < 3 || parts.some(isNaN)) {
    return '1.0.0';
  }
  parts[2] += 1;
  return parts.join('.');
}

function getQrValueFromAmount(amount: string): number {
  const amountMap: { [key: string]: number } = {
    '49': 0,
    '59': 1,
    '69': 2,
    '79': 3,
    '89': 4,
    '99': 5,
    '109': 6
  };
  
  const qrValue = amountMap[amount];
  if (qrValue === undefined) {
    throw new Error('Invalid amount selected. Allowed values: 49, 59, 69, 79, 89, 99, 109');
  }
  
  return qrValue;
}

export class OtaController {
  // GET /api/machine/:machineId/qr-value
  public static async getQrValue(req: Request, res: Response): Promise<Response> {
    try {
      const { machineId } = req.params;
      console.log(`[OTA] Fetching QR value for machine: ${machineId}`);
      
      if (!machineId || machineId.trim() === '') {
        return res.status(400).json({
          success: false,
          message: 'Machine ID is required'
        });
      }
      
      const latestFirmware = await Firmware.findOne({ machineId }).sort({ createdAt: -1 });
      
      if (!latestFirmware) {
        return res.status(200).json({
          success: false,
          exists: false,
          message: 'Machine not found. Please upload firmware first.',
          machineId: machineId,
          qrValue: null
        });
      }
      
      const qrValue = latestFirmware.qrvalue !== undefined && latestFirmware.qrvalue !== null 
        ? latestFirmware.qrvalue.toString() 
        : '0';
      
      return res.json({
        success: true,
        exists: true,
        machineId: machineId,
        machineName: latestFirmware.machineName,
        qrValue: qrValue,
        qrValueNumber: latestFirmware.qrvalue,
        currentVersion: latestFirmware.version,
        lastUpdated: latestFirmware.createdAt
      });
      
    } catch (err: any) {
      console.error('[OTA] Get QR value error:', err);
      return res.status(500).json({
        success: false,
        message: 'Server error while fetching QR value',
        error: err.message
      });
    }
  }

  // GET /api/machine/:machineId
  public static async checkMachine(req: Request, res: Response): Promise<Response> {
    try {
      const { machineId } = req.params;
      console.log(`[OTA] Checking if machine exists: ${machineId}`);
      
      const latestFirmware = await Firmware.findOne({ machineId }).sort({ createdAt: -1 });
      
      if (!latestFirmware) {
        return res.status(404).json({
          exists: false,
          message: 'Machine not found'
        });
      }
      
      return res.json({
        exists: true,
        machineId: latestFirmware.machineId,
        machineName: latestFirmware.machineName,
        qrValue: latestFirmware.qrvalue !== undefined ? latestFirmware.qrvalue.toString() : '0',
        currentVersion: latestFirmware.version || '1.0.0'
      });
      
    } catch (err: any) {
      console.error('[OTA] Check machine error:', err);
      return res.status(500).json({
        message: 'Server error',
        exists: false
      });
    }
  }

  // PUT /api/machine/:machineId/qr
  public static async updateQrValue(req: Request, res: Response): Promise<Response> {
    try {
      const { machineId } = req.params;
      const { qrValue } = req.body;
      
      console.log(`[OTA] Updating QR value for machine: ${machineId} to ${qrValue}`);
      
      if (qrValue === undefined || qrValue === null) {
        return res.status(400).json({
          message: 'QR value is required'
        });
      }
      
      const qrValueNum = parseInt(qrValue);
      if (isNaN(qrValueNum) || ![0, 1, 2, 3, 4, 5, 6].includes(qrValueNum)) {
        return res.status(400).json({
          message: 'Invalid QR value. Allowed values: 0, 1, 2, 3, 4, 5, 6'
        });
      }
      
      const existingMachine = await Firmware.findOne({ machineId });
      
      if (!existingMachine) {
        return res.status(404).json({
          message: 'Machine not found. Please upload firmware first.'
        });
      }
      
      await Firmware.findOneAndUpdate(
        { machineId },
        { qrvalue: qrValueNum },
        { sort: { createdAt: -1 }, new: true }
      );
      
      return res.json({
        success: true,
        message: 'QR value updated successfully',
        machineId: machineId,
        newQrValue: qrValueNum,
        updatedAt: new Date()
      });
      
    } catch (err: any) {
      console.error('[OTA] QR update error:', err);
      return res.status(500).json({
        message: 'Server error while updating QR value'
      });
    }
  }

  // PUT /api/machine/:machineId/info
  public static async updateMachineInfo(req: Request, res: Response): Promise<Response> {
    try {
      const { machineId } = req.params;
      const { machineName, amount } = req.body;
      
      console.log(`[OTA] Updating machine info for: ${machineId}`);
      
      if (!machineName && !amount) {
        return res.status(400).json({
          message: 'At least one field (machineName or amount) is required for update'
        });
      }
      
      const existingMachine = await Firmware.findOne({ machineId });
      
      if (!existingMachine) {
        return res.status(404).json({
          message: 'Machine not found. Please upload firmware first.'
        });
      }
      
      const updateData: any = {};
      if (machineName) updateData.machineName = machineName;
      if (amount) {
        try {
          const qrValue = getQrValueFromAmount(amount.toString());
          updateData.qrvalue = qrValue;
        } catch (err: any) {
          return res.status(400).json({ message: err.message });
        }
      }
      
      await Firmware.findOneAndUpdate(
        { machineId },
        updateData,
        { sort: { createdAt: -1 }, new: true }
      );
      
      return res.json({
        success: true,
        message: 'Machine information updated successfully',
        machineId: machineId,
        updates: updateData
      });
      
    } catch (err: any) {
      console.error('[OTA] Machine info update error:', err);
      return res.status(500).json({
        message: 'Server error while updating machine info'
      });
    }
  }

  // POST /add
  public static async uploadFirmware(req: Request, res: Response): Promise<Response> {
    try {
      console.log('[OTA] Upload request received');
      
      const { machineId, machineName, amount } = req.body;
      
      if (!machineId || !machineName) {
        return res.status(400).json({ message: 'Machine info missing' });
      }
      
      if (!amount) {
        return res.status(400).json({ message: 'Amount is required' });
      }
      
      let qrvalue: number;
      try {
        qrvalue = getQrValueFromAmount(amount.toString());
      } catch (err: any) {
        return res.status(400).json({ message: err.message });
      }
      
      const existingMachine = await Firmware.findOne({ machineId });
      
      if (!req.file) {
        console.log('[OTA] No file provided - updating only machine info and QR');
        
        if (!existingMachine) {
          return res.status(404).json({ 
            message: 'Machine not found. Please upload firmware file for new machines.'
          });
        }
        
        await Firmware.findOneAndUpdate(
          { machineId },
          { 
            machineName: machineName,
            qrvalue: qrvalue
          },
          { sort: { createdAt: -1 }, new: true }
        );
        
        return res.json({
          message: 'Machine information updated successfully',
          machineId,
          machineName,
          amount,
          qrvalue,
          updated: true,
          noFirmwareChange: true
        });
      }
      
      if (!req.file.originalname.endsWith('.bin')) {
        return res.status(400).json({ message: 'Only .bin files allowed' });
      }
      
      const latest = await Firmware.findOne({ machineId }).sort({ createdAt: -1 });
      const version = latest ? incrementVersion(latest.version) : '1.0.0';
      
      console.log(`[OTA] Upload details - Machine: ${machineId}, Name: ${machineName}, Version: ${version}, Amount: ${amount}`);
      
      let fileUrl = '';
      let publicId = `freshpod/${machineId}/${version}`;
      let fileSize = req.file.size;

      const useCloudinary = !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);

      if (useCloudinary) {
        console.log('[OTA] Uploading binary to Cloudinary...');
        const uploadResult: any = await new Promise((resolve, reject) => {
          const uploadStream = cloudinary.uploader.upload_stream(
            {
              resource_type: 'raw',
              public_id: publicId,
              overwrite: true,
            },
            (error, result) => {
              if (error) return reject(error);
              resolve(result);
            }
          );
          streamifier.createReadStream(req.file!.buffer).pipe(uploadStream);
        });
        fileUrl = uploadResult.secure_url;
        publicId = uploadResult.public_id;
        fileSize = uploadResult.bytes || req.file.size;
      } else {
        console.log('[OTA] Cloudinary credentials missing. Falling back to local disk storage...');
        const localDir = path.join(process.cwd(), 'uploads', 'firmware', machineId);
        if (!fs.existsSync(localDir)) {
          fs.mkdirSync(localDir, { recursive: true });
        }
        const fileName = `${version}.bin`;
        const filePath = path.join(localDir, fileName);
        fs.writeFileSync(filePath, req.file.buffer);
        
        const host = req.headers.host || 'localhost:5000';
        const protocol = req.secure ? 'https' : 'http';
        fileUrl = `${protocol}://${host}/uploads/firmware/${machineId}/${fileName}`;
        publicId = `local/${machineId}/${version}`;
      }
      
      const firmware = await Firmware.create({
        machineId,
        machineName,
        version,
        qrvalue,
        file: {
          public_id: publicId,
          url: fileUrl,
          size: fileSize,
        },
      });
      
      return res.json({
        message: 'Firmware uploaded successfully',
        machineId,
        machineName,
        version,
        amount,
        qrvalue,
        url: firmware.file.url,
      });
      
    } catch (err: any) {
      console.error('[OTA] Upload error:', err);
      return res.status(500).json({
        message: err.message,
      });
    }
  }

  // GET /firmware/:machineId
  public static async getLatestFirmware(req: Request, res: Response): Promise<Response> {
    try {
      const { machineId } = req.params;
      console.log(`[OTA] ESP32 checking latest firmware for machine: ${machineId}`);
      
      const latest = await Firmware.findOne({ machineId }).sort({ createdAt: -1 });
      
      if (!latest) {
        return res.status(404).json({
          message: 'Firmware not found',
        });
      }
      
      res.setHeader('Cache-Control', 'no-store');
      
      return res.json({
        machineId,
        version: latest.version,
        url: latest.file.url,
        qrvalue: latest.qrvalue,
      });
      
    } catch (err: any) {
      console.error('[OTA] GET error:', err);
      return res.status(500).json({
        message: 'Server error',
      });
    }
  }

  // GET /firmware/:machineId/:qrvalue
  public static async getLatestFirmwareWithQr(req: Request, res: Response): Promise<Response> {
    try {
      const { machineId, qrvalue } = req.params;
      console.log(`[OTA] ESP32 checking firmware for: ${machineId} with qrvalue: ${qrvalue}`);
      
      const qrValueNum = parseInt(qrvalue);
      if (isNaN(qrValueNum) || ![0, 1, 2, 3, 4, 5, 6].includes(qrValueNum)) {
        return res.status(400).json({
          message: 'Invalid qrvalue. Allowed values: 0, 1, 2, 3, 4, 5, 6',
        });
      }
      
      const firmware = await Firmware.findOne({ 
        machineId, 
        qrvalue: qrValueNum 
      }).sort({ createdAt: -1 });
      
      if (!firmware) {
        return res.status(404).json({
          message: `Firmware not found for machine ${machineId} with qrvalue ${qrvalue}`,
        });
      }
      
      res.setHeader('Cache-Control', 'no-store');
      
      return res.json({
        machineId,
        version: firmware.version,
        url: firmware.file.url,
        qrvalue: firmware.qrvalue,
      });
      
    } catch (err: any) {
      console.error('[OTA] GET error:', err);
      return res.status(500).json({
        message: 'Server error',
      });
    }
  }

  // GET /firmware/:machineId/all
  public static async getAllVersions(req: Request, res: Response): Promise<Response> {
    try {
      const { machineId } = req.params;
      console.log(`[OTA] Getting all firmware versions for machine: ${machineId}`);
      
      const allFirmware = await Firmware.find({ machineId }).sort({ createdAt: -1 });
      
      if (!allFirmware.length) {
        return res.status(404).json({
          message: 'No firmware found for this machine',
        });
      }
      
      return res.json({
        machineId,
        count: allFirmware.length,
        firmware: allFirmware.map(fw => ({
          version: fw.version,
          qrvalue: fw.qrvalue,
          uploadedAt: fw.createdAt,
          url: fw.file.url,
        })),
      });
      
    } catch (err: any) {
      console.error('[OTA] GET error:', err);
      return res.status(500).json({
        message: 'Server error',
      });
    }
  }
}
