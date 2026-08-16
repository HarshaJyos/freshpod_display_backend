import { Router } from 'express';
import { OtaController } from './ota.controller';
import multer from 'multer';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }
});

const router = Router();

// ESP32 OTA Endpoint check routes
router.get('/firmware/:machineId', OtaController.getLatestFirmware);
router.get('/firmware/:machineId/:qrvalue', OtaController.getLatestFirmwareWithQr);
router.get('/firmware/:machineId/all', OtaController.getAllVersions);

// Admin dashboard panel routes
router.post('/add', upload.single('file'), OtaController.uploadFirmware);
router.get('/api/machine/:machineId/qr-value', OtaController.getQrValue);
router.get('/api/machine/:machineId', OtaController.checkMachine);
router.put('/api/machine/:machineId/qr', OtaController.updateQrValue);
router.put('/api/machine/:machineId/info', OtaController.updateMachineInfo);

export default router;
