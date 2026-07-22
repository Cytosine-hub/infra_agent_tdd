import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 门户经 nginx 反代以 portal.shcj-s.com 对外提供；Next 16 dev 默认拦截跨域 dev 资源（HMR、_next 等），
  // 必须把对外域名加入白名单，否则通过反代访问时前端 JS/HMR 被拦，页面功能全废。
  allowedDevOrigins: ["portal.shcj-s.com"],
  // 关闭左下角的开发指示器（编译/运行时错误仍会提示）
  devIndicators: false,
};

export default nextConfig;
