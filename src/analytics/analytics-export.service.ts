import { Injectable } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { AnalyticsService } from './analytics.service';

/**
 * Builds the admin analytics workbook.
 *
 * One sheet per metric rather than one flattened table, because these
 * metrics have genuinely different shapes — a session summary is four
 * numbers per segment, page timing is a ranked list of a hundred routes.
 * Stacking them into a single CSV would need filler columns everywhere and
 * would be read by nobody.
 *
 * Durations are written twice: raw milliseconds for anyone doing further
 * arithmetic, and a rounded minutes column so the sheet is readable without
 * any. The raw column is the one to trust.
 */
@Injectable()
export class AnalyticsExportService {
  constructor(private readonly analytics: AnalyticsService) {}

  async buildWorkbook(from?: string, to?: string): Promise<Buffer> {
    const [sessions, timePerPage, categories, terms, split] = await Promise.all([
      this.analytics.getSessionDurations(from, to),
      this.analytics.getTimePerPage(from, to),
      this.analytics.getCategoryDemand(from, to),
      this.analytics.getTopSearchTerms(from, to),
      this.analytics.getAudienceSplit(from, to),
    ]);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Fann';
    workbook.created = new Date();

    // ── Summary ──
    const summary = workbook.addWorksheet('Summary');
    summary.columns = [
      { header: 'Metric', key: 'metric', width: 34 },
      { header: 'Segment', key: 'segment', width: 16 },
      { header: 'Value', key: 'value', width: 16 },
    ];
    summary.addRow({ metric: 'Report from', value: from ?? 'all time' });
    summary.addRow({ metric: 'Report to', value: to ?? 'today' });
    summary.addRow({});
    for (const row of split.pageViews) {
      summary.addRow({ metric: 'Page views', segment: row.segment, value: row.events });
      summary.addRow({ metric: 'Sessions', segment: row.segment, value: row.sessions });
    }
    for (const row of split.searches) {
      summary.addRow({ metric: 'Searches', segment: row.segment, value: row.searches });
    }
    summary.addRow({
      metric: 'Single-event sessions discarded',
      value: sessions.discardedSingleEventSessions,
    });

    // ── Session duration ──
    const sessionSheet = workbook.addWorksheet('Session duration');
    sessionSheet.columns = [
      { header: 'Segment', key: 'segment', width: 16 },
      { header: 'Sessions', key: 'sessions', width: 12 },
      { header: 'Min (ms)', key: 'minMs', width: 14 },
      { header: 'Max (ms)', key: 'maxMs', width: 14 },
      { header: 'Average (ms)', key: 'avgMs', width: 16 },
      { header: 'Median (ms)', key: 'medianMs', width: 16 },
      { header: 'Average (min)', key: 'avgMin', width: 16 },
      { header: 'Median (min)', key: 'medianMin', width: 16 },
    ];
    for (const row of sessions.bySegment) {
      sessionSheet.addRow({
        ...row,
        avgMin: minutes(row.avgMs),
        medianMin: minutes(row.medianMs),
      });
    }

    // ── Time per page ──
    const pageSheet = workbook.addWorksheet('Time per page');
    pageSheet.columns = [
      { header: 'Path', key: 'path', width: 34 },
      { header: 'Segment', key: 'segment', width: 16 },
      { header: 'Views', key: 'views', width: 12 },
      { header: 'Total (ms)', key: 'totalMs', width: 16 },
      { header: 'Average (ms)', key: 'avgMs', width: 16 },
      { header: 'Total (min)', key: 'totalMin', width: 14 },
    ];
    for (const row of timePerPage) {
      pageSheet.addRow({ ...row, totalMin: minutes(row.totalMs) });
    }

    // ── Category demand ──
    const categorySheet = workbook.addWorksheet('Category demand');
    categorySheet.columns = [
      { header: 'Category', key: 'category', width: 30 },
      { header: 'Slug', key: 'slug', width: 22 },
      { header: 'Segment', key: 'segment', width: 16 },
      { header: 'Searches', key: 'searches', width: 12 },
      { header: 'Avg results', key: 'avgResults', width: 14 },
    ];
    for (const row of categories) categorySheet.addRow(row);

    // ── Search terms ──
    const termSheet = workbook.addWorksheet('Search terms');
    termSheet.columns = [
      { header: 'Term', key: 'term', width: 40 },
      { header: 'Searches', key: 'searches', width: 12 },
    ];
    for (const row of terms) termSheet.addRow(row);

    for (const sheet of workbook.worksheets) {
      sheet.getRow(1).font = { bold: true };
      sheet.views = [{ state: 'frozen', ySplit: 1 }];
    }

    // exceljs declares its own Buffer interface that does not structurally
    // match Node's, so TypeScript refuses the direct cast. The runtime value
    // genuinely is a Node Buffer — which is what res.end() needs — so the
    // hop through unknown is asserting a fact, not papering over a mismatch.
    return (await workbook.xlsx.writeBuffer()) as unknown as Buffer;
  }
}

function minutes(ms: number): number {
  return Math.round((ms / 60_000) * 10) / 10;
}
