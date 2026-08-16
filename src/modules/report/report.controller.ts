import { Request, Response } from 'express';
import { ReportService } from './report.service';

export class ReportController {

  /**
   * Retrieve active support tickets.
   */
  static async getReports(req: any, res: Response) {
    try {
      const reports = await ReportService.getReports(req.user.id || req.user.uid, req.user.role);
      res.json(reports);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  /**
   * Log a new support ticket.
   */
  static async createReport(req: any, res: Response) {
    try {
      const { subject, description } = req.body;
      if (!subject || !description) {
        return res.status(400).json({ error: 'Subject and Description are required' });
      }

      const report = await ReportService.createReport(
        req.user.id || req.user.uid,
        req.user.email,
        subject,
        description
      );

      res.status(201).json({ success: true, message: 'Ticket registered successfully', report });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  /**
   * Fetch specific support ticket details.
   */
  static async getReportDetail(req: any, res: Response) {
    try {
      const { reportId } = req.params;
      const report = await ReportService.getReportDetail(reportId, req.user.id || req.user.uid, req.user.role);
      if (!report) return res.status(404).json({ error: 'Report ticket not found or access denied' });

      res.json(report);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  /**
   * Mark a support ticket as resolved.
   */
  static async solveReport(req: any, res: Response) {
    try {
      const { reportId } = req.params;
      const { notes } = req.body;

      const report = await ReportService.markReportSolved(reportId, notes || "");
      res.json({ success: true, message: 'Support ticket resolved successfully', report });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  /**
   * Delete a support ticket.
   */
  static async deleteReport(req: any, res: Response) {
    try {
      const { reportId } = req.params;
      const report = await ReportService.deleteReport(reportId);
      res.json({ success: true, message: 'Support ticket deleted successfully', report });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }
}
