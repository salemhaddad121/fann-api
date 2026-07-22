import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import {
  AppleConfiguredGuard,
  GoogleConfiguredGuard,
} from './guards/oauth-configured.guard';
import {
  ChangeEmailDto,
  ChangePasswordDto,
  DeleteAccountDto,
  ForgotPasswordDto,
  LoginDto,
  RegisterDto,
  ResetPasswordDto,
  SendOtpDto,
  VerifyOtpDto,
} from './dto/auth.dto';
import { JwtAuthGuard, LocalAuthGuard } from './guards/auth.guards';
import { CurrentUser } from './decorators/auth.decorators';
import { UserRecord } from '../users/users.types';
import {
  setAuthCookies,
  setAccessTokenCookie,
  clearAuthCookies,
  REFRESH_TOKEN_COOKIE,
} from './auth-cookie.util';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // ----------------------------------------------------------------
  // POST /auth/register
  // ----------------------------------------------------------------
  @Post('register')
  async register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  // ----------------------------------------------------------------
  // POST /auth/login
  // LocalAuthGuard runs validateLocalUser before the handler is reached.
  // ----------------------------------------------------------------
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @UseGuards(LocalAuthGuard)
  async login(
    @CurrentUser() user: UserRecord,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { accessToken, refreshToken, user: safeUser } = await this.authService.login(user);
    setAuthCookies(res, { accessToken, refreshToken });
    return { user: safeUser };
  }

  // ----------------------------------------------------------------
  // POST /auth/refresh
  // ----------------------------------------------------------------
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const refreshToken = req.cookies?.[REFRESH_TOKEN_COOKIE];
    if (!refreshToken) {
      throw new UnauthorizedException('No refresh token provided.');
    }

    const { accessToken } = await this.authService.refresh(refreshToken);
    setAccessTokenCookie(res, accessToken);
    return { message: 'Access token refreshed.' };
  }

  // ----------------------------------------------------------------
  // POST /auth/logout
  // ----------------------------------------------------------------
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  async logout(
    @CurrentUser('id') userId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.logout(userId);
    clearAuthCookies(res);
    return result;
  }

  // ----------------------------------------------------------------
  // GET /auth/verify-email?token=...
  // ----------------------------------------------------------------
  @Get('verify-email')
  async verifyEmail(@Query('token') token: string) {
    return this.authService.verifyEmail(token);
  }

  // ----------------------------------------------------------------
  // POST /auth/forgot-password
  // Always returns a generic success message regardless of whether
  // the email exists — avoids leaking account existence.
  // ----------------------------------------------------------------
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto.email);
  }

  // ----------------------------------------------------------------
  // POST /auth/reset-password
  // ----------------------------------------------------------------
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  async resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto.token, dto.password);
  }

  // ----------------------------------------------------------------
  // PATCH /auth/password — change password while logged in
  // ----------------------------------------------------------------
  @Patch('password')
  @UseGuards(JwtAuthGuard)
  async changePassword(
    @CurrentUser('id') userId: string,
    @Body() dto: ChangePasswordDto,
  ) {
    return this.authService.changePassword(userId, dto.currentPassword, dto.newPassword);
  }

  // ----------------------------------------------------------------
  // PATCH /auth/email — request an email change while logged in.
  // Doesn't take effect until the verification link sent to the new
  // address is clicked — see requestEmailChange() in auth.service.ts.
  // ----------------------------------------------------------------
  @Patch('email')
  @UseGuards(JwtAuthGuard)
  async changeEmail(
    @CurrentUser('id') userId: string,
    @Body() dto: ChangeEmailDto,
  ) {
    return this.authService.requestEmailChange(userId, dto.newEmail, dto.currentPassword);
  }

  // ----------------------------------------------------------------
  // DELETE /auth/me — soft-delete your own account
  // ----------------------------------------------------------------
  @Delete('me')
  @UseGuards(JwtAuthGuard)
  async deleteAccount(
    @CurrentUser('id') userId: string,
    @Body() dto: DeleteAccountDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.deleteAccount(userId, dto.password);
    clearAuthCookies(res);
    return result;
  }

  // ----------------------------------------------------------------
  // POST /auth/send-otp
  // ----------------------------------------------------------------
  @Post('send-otp')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  async sendOtp(
    @CurrentUser('id') userId: string,
    @Body() dto: SendOtpDto,
  ) {
    return this.authService.sendOtp(userId, dto.phone);
  }

  // ----------------------------------------------------------------
  // POST /auth/verify-otp
  // ----------------------------------------------------------------
  @Post('verify-otp')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  async verifyOtp(
    @CurrentUser('id') userId: string,
    @Body() dto: VerifyOtpDto,
  ) {
    return this.authService.verifyOtp(userId, dto.phone, dto.code);
  }

  // ----------------------------------------------------------------
  // GET /auth/google?state=artist|planner
  // Initiates Google OAuth flow. `state` carries the role the user
  // signed up as so the callback knows which profile to create.
  // ----------------------------------------------------------------
  @Get('google')
  @UseGuards(GoogleConfiguredGuard, AuthGuard('google'))
  googleLogin() {
    // Passport redirects automatically — no body needed.
  }

  @Get('google/callback')
  @UseGuards(GoogleConfiguredGuard, AuthGuard('google'))
  async googleCallback(@Req() req: Request, @Res() res: Response) {
    const user = req.user as UserRecord;
    const tokens = await this.authService.loginOAuthUser(user);

    setAuthCookies(res, tokens);

    const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:3000';
    return res.redirect(`${frontendUrl}/auth/callback`);
  }

  // ----------------------------------------------------------------
  // GET /auth/apple?state=artist|planner
  // Apple uses a POST callback (form_post response mode)
  // ----------------------------------------------------------------
  @Get('apple')
  @UseGuards(AppleConfiguredGuard, AuthGuard('apple'))
  appleLogin() {}

  @Post('apple/callback')
  @UseGuards(AppleConfiguredGuard, AuthGuard('apple'))
  async appleCallback(@Req() req: Request, @Res() res: Response) {
    const user = req.user as UserRecord;
    const tokens = await this.authService.loginOAuthUser(user);

    setAuthCookies(res, tokens);

    const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:3000';
    return res.redirect(`${frontendUrl}/auth/callback`);
  }

  // ----------------------------------------------------------------
  // GET /auth/me  — handy for the client to rehydrate session
  // ----------------------------------------------------------------
  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: UserRecord) {
    const { passwordHash, ...safe } = user as any;
    return safe;
  }
}
