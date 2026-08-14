import Report, { IReport } from './report.model';

export class ReportService {

  /**
   * Fetch support tickets list based on role.
   */
  static async getReports(userId: string, role: string) {
    let query: any = { isDeleted: { $ne: true } };
    if (role === 'customer') {
      query = { 'customer.id': userId, isDeleted: { $ne: true } };
    }
    return await Report.find(query).sort({ createdAt: -1 });
  }

  /**
   * Create a new technical support ticket.
   */
  static async createReport(userId: string, email: string, subject: string, description: string) {
    const reportId = `REP_${Date.now()}`;
    return await Report.create({
      reportId,
      customer: {
        id: userId,
        email
      },
      subject,
      description,
      status: 'pending'
    });
  }

  /**
   * Fetch specific support ticket detail.
   */
  static async getReportDetail(reportId: string, userId: string, role: string) {
    let query: any = { reportId, isDeleted: { $ne: true } };
    if (role === 'customer') {
      query = { reportId, 'customer.id': userId, isDeleted: { $ne: true } };
    }
    return await Report.findOne(query);
  }

  /**
   * Update support ticket status to solved.
   */
  static async markReportSolved(reportId: string, resolutionNotes: string) {
    const report = await Report.findOne({ reportId, isDeleted: { $ne: true } });
    if (!report) throw new Error('Report ticket not found');

    return await report.markAsSolved(resolutionNotes);
  }
}
