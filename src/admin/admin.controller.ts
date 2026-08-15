import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { AdminService } from './admin.service';
import { VerificationService } from '../verification/verification.service';
import { ReviewsService } from '../reviews/reviews.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { AnalyticsExportService } from '../analytics/analytics-export.service';
import {
  AuditLogDto,
  CreateCategoryDto,
  CreateCategoryGroupDto,
  ListUsersDto,
  PaginationDto,
  ResolveFlagDto,
  ReviewIdDocumentDto,
  ReviewPaymentDto,
  UpdateCategoryDto,
  UpdateCategoryGroupDto,
  ResetUserPasswordDto,
  UpdateUserStatusDto,
  ListVerificationsDto,
} from './dto/admin.dto';
import { JwtAuthGuard, RolesGuard } from '../auth/guards/auth.guards';
import { CurrentUser, Roles } from '../auth/decorators/auth.decorators';

// Every route in this controller requires a valid JWT + admin role.
@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly reviewsService: ReviewsService,
    private readonly analyticsService: AnalyticsService,
    private readonly analyticsExportService: AnalyticsExportService,
    private readonly verificationService: VerificationService,
  ) {}

  // ----------------------------------------------------------------
  // Dashboard
  // ----------------------------------------------------------------

  // GET /admin/stats
  @Get('stats')
  getStats() {
    return this.adminService.getStats();
  }

  // GET /admin/analytics/signups?days=30
  @Get('analytics/signups')
  getSignupTrend(@Query('days') days?: string) {
    const parsed = Math.min(Math.max(Number(days) || 30, 1), 90);
    return this.adminService.getSignupTrend(parsed);
  }

  // GET /admin/analytics/geography
  @Get('analytics/geography')
  getGeographyBreakdown() {
    return this.adminService.getGeographyBreakdown();
  }

  // GET /admin/analytics/booked-categories
  @Get('analytics/booked-categories')
  getTopBookedCategories() {
    return this.adminService.getTopBookedCategories(5);
  }

  // GET /admin/analytics/booker-types
  @Get('analytics/booker-types')
  getTopBookerTypes() {
    return this.adminService.getTopBookerTypes(3);
  }

  // GET /admin/analytics/engagement
  // Average foreground time per active day, split by role, overall and on
  // the search page. Backed by page_events, which only started collecting
  // when migration 014 ran — expect it to be empty until real usage lands.
  @Get('analytics/engagement')
  getEngagement() {
    return this.analyticsService.getEngagement();
  }

  // GET /admin/analytics/sessions?from=&to=
  // min / max / average / median session length, guest vs authenticated.
  @Get('analytics/sessions')
  getSessionDurations(@Query('from') from?: string, @Query('to') to?: string) {
    return this.analyticsService.getSessionDurations(from, to);
  }

  // GET /admin/analytics/time-per-page?from=&to=
  @Get('analytics/time-per-page')
  getTimePerPage(@Query('from') from?: string, @Query('to') to?: string) {
    return this.analyticsService.getTimePerPage(from, to);
  }

  // GET /admin/analytics/category-demand?from=&to=
  // What people search for, ranked, with absolute counts.
  @Get('analytics/category-demand')
  getCategoryDemand(@Query('from') from?: string, @Query('to') to?: string) {
    return this.analyticsService.getCategoryDemand(from, to);
  }

  // GET /admin/analytics/search-terms?from=&to=
  @Get('analytics/search-terms')
  getTopSearchTerms(@Query('from') from?: string, @Query('to') to?: string) {
    return this.analyticsService.getTopSearchTerms(from, to);
  }

  // GET /admin/analytics/audience?from=&to=
  @Get('analytics/audience')
  getAudienceSplit(@Query('from') from?: string, @Query('to') to?: string) {
    return this.analyticsService.getAudienceSplit(from, to);
  }

  // GET /admin/analytics/export?from=&to=
  //
  // Streams a real .xlsx, one sheet per metric. @Res({ passthrough: false })
  // because the body is a binary Buffer, not JSON — returning it through
  // Nest's normal serialisation would corrupt it.
  @Get('analytics/export')
  async exportAnalytics(
    @Res() res: Response,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const buffer = await this.analyticsExportService.buildWorkbook(from, to);
    const stamp = new Date().toISOString().slice(0, 10);

    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="fann-analytics-${stamp}.xlsx"`,
      'Content-Length': String(buffer.length),
    });
    res.end(buffer);
  }

  // ----------------------------------------------------------------
  // Users
  // ----------------------------------------------------------------

  // GET /admin/users?role=&status=&q=&page=&limit=
  @Get('users')
  listUsers(@Query() dto: ListUsersDto) {
    return this.adminService.listUsers(dto);
  }

  // GET /admin/users/:id
  @Get('users/:id')
  getUser(@Param('id', ParseUUIDPipe) userId: string) {
    return this.adminService.getUser(userId);
  }

  // PATCH /admin/users/:id/status
  @Patch('users/:id/status')
  @HttpCode(HttpStatus.OK)
  updateUserStatus(
    @CurrentUser('id') adminId: string,
    @Param('id', ParseUUIDPipe) userId: string,
    @Body() dto: UpdateUserStatusDto,
  ) {
    return this.adminService.updateUserStatus(adminId, userId, dto);
  }

  // POST /admin/users/:id/reset-password
  // Returns a freshly generated temporary password, once. Nothing stores it
  // in plaintext, so it cannot be retrieved again — the admin has to pass it
  // to the user and then reset again if it's lost.
  @Post('users/:id/reset-password')
  @HttpCode(HttpStatus.OK)
  resetUserPassword(
    @CurrentUser('id') adminId: string,
    @Param('id', ParseUUIDPipe) userId: string,
    @Body() dto: ResetUserPasswordDto,
  ) {
    return this.adminService.resetUserPassword(adminId, userId, dto.note);
  }

  // ----------------------------------------------------------------
  // ID Documents
  // ----------------------------------------------------------------

  // GET /admin/id-documents?page=&limit=
  @Get('id-documents')
  listDocuments(@Query() dto: PaginationDto) {
    return this.adminService.listPendingDocuments(dto);
  }

  // PATCH /admin/id-documents/:id
  @Patch('id-documents/:id')
  @HttpCode(HttpStatus.OK)
  reviewDocument(
    @CurrentUser('id') adminId: string,
    @Param('id', ParseUUIDPipe) docId: string,
    @Body() dto: ReviewIdDocumentDto,
  ) {
    return this.adminService.reviewDocument(adminId, docId, dto);
  }

  // ----------------------------------------------------------------
  // Payments
  // ----------------------------------------------------------------

  // GET /admin/payments?page=&limit=
  @Get('payments')
  listPayments(@Query() dto: PaginationDto) {
    return this.adminService.listPendingPayments(dto);
  }

  // PATCH /admin/payments/:id
  @Patch('payments/:id')
  @HttpCode(HttpStatus.OK)
  reviewPayment(
    @CurrentUser('id') adminId: string,
    @Param('id', ParseUUIDPipe) paymentId: string,
    @Body() dto: ReviewPaymentDto,
  ) {
    return this.adminService.reviewPayment(adminId, paymentId, dto);
  }

  // ----------------------------------------------------------------
  // Flags
  // ----------------------------------------------------------------

  // GET /admin/flags?page=&limit=
  @Get('flags')
  listFlags(@Query() dto: PaginationDto) {
    return this.adminService.listOpenFlags(dto);
  }

  // PATCH /admin/flags/:id
  @Patch('flags/:id')
  @HttpCode(HttpStatus.OK)
  resolveFlag(
    @CurrentUser('id') adminId: string,
    @Param('id', ParseUUIDPipe) flagId: string,
    @Body() dto: ResolveFlagDto,
  ) {
    return this.adminService.resolveFlag(adminId, flagId, dto);
  }

  // ----------------------------------------------------------------
  // Category groups
  // ----------------------------------------------------------------

  // GET /admin/category-groups — includes category_count per group
  @Get('category-groups')
  listCategoryGroups() {
    return this.adminService.listCategoryGroups();
  }

  // POST /admin/category-groups
  @Post('category-groups')
  @HttpCode(HttpStatus.CREATED)
  createCategoryGroup(
    @CurrentUser('id') adminId: string,
    @Body() dto: CreateCategoryGroupDto,
  ) {
    return this.adminService.createCategoryGroup(adminId, dto);
  }

  // PATCH /admin/category-groups/:id
  @Patch('category-groups/:id')
  @HttpCode(HttpStatus.OK)
  updateCategoryGroup(
    @CurrentUser('id') adminId: string,
    @Param('id', ParseUUIDPipe) groupId: string,
    @Body() dto: UpdateCategoryGroupDto,
  ) {
    return this.adminService.updateCategoryGroup(adminId, groupId, dto);
  }

  // DELETE /admin/category-groups/:id — blocked if any category still belongs to it
  @Delete('category-groups/:id')
  @HttpCode(HttpStatus.OK)
  deleteCategoryGroup(
    @CurrentUser('id') adminId: string,
    @Param('id', ParseUUIDPipe) groupId: string,
  ) {
    return this.adminService.deleteCategoryGroup(adminId, groupId);
  }

  // ----------------------------------------------------------------
  // Categories
  // ----------------------------------------------------------------

  // GET /admin/categories — includes artist_count per category
  @Get('categories')
  listCategories() {
    return this.adminService.listCategoriesAdmin();
  }

  // POST /admin/categories
  @Post('categories')
  @HttpCode(HttpStatus.CREATED)
  createCategory(
    @CurrentUser('id') adminId: string,
    @Body() dto: CreateCategoryDto,
  ) {
    return this.adminService.createCategory(adminId, dto);
  }

  // PATCH /admin/categories/:id
  @Patch('categories/:id')
  @HttpCode(HttpStatus.OK)
  updateCategory(
    @CurrentUser('id') adminId: string,
    @Param('id', ParseUUIDPipe) categoryId: string,
    @Body() dto: UpdateCategoryDto,
  ) {
    return this.adminService.updateCategory(adminId, categoryId, dto);
  }

  // DELETE /admin/categories/:id — blocked if any artist profile still uses it
  @Delete('categories/:id')
  @HttpCode(HttpStatus.OK)
  deleteCategory(
    @CurrentUser('id') adminId: string,
    @Param('id', ParseUUIDPipe) categoryId: string,
  ) {
    return this.adminService.deleteCategory(adminId, categoryId);
  }

  // ----------------------------------------------------------------
  // Audit log
  // ----------------------------------------------------------------

  // GET /admin/audit-log?adminId=&targetId=&action=&page=&limit=
  @Get('audit-log')
  getAuditLog(@Query() dto: AuditLogDto) {
    return this.adminService.getAuditLog(dto);
  }

  // ----------------------------------------------------------------
  // Reviews (moderation)
  // ----------------------------------------------------------------

  // GET /admin/reviews?page=&limit=
  @Get('reviews')
  listReviews(@Query() dto: PaginationDto) {
    return this.adminService.listReviews(dto);
  }

  // DELETE /admin/reviews/:id — hide a review
  @Delete('reviews/:id')
  @HttpCode(HttpStatus.OK)
  removeReview(
    @CurrentUser('id') adminId: string,
    @Param('id', ParseUUIDPipe) reviewId: string,
  ) {
    return this.adminService.removeReview(adminId, reviewId, this.reviewsService);
  }

  // ----------------------------------------------------------------
  // Verification records
  //
  // The identity-verification audit trail. Provider-sourced fields are
  // empty until a provider is integrated — see migration 017.
  // ----------------------------------------------------------------

  // GET /admin/verifications?result=&page=&limit=
  @Get('verifications')
  listVerifications(@Query() dto: ListVerificationsDto) {
    return this.verificationService.list({
      result: dto.result,
      page: dto.page,
      limit: dto.limit,
    });
  }

  // GET /admin/verifications/user/:userId — full history for one account
  @Get('verifications/user/:userId')
  listUserVerifications(@Param('userId', ParseUUIDPipe) userId: string) {
    return this.verificationService.listForUser(userId);
  }
}
