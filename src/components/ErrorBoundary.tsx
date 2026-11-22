import React from 'react';
import { getActiveRuntimeLanguage, tLang } from '../i18n';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  sectionName?: string;
  onReset?: () => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    const lang = getActiveRuntimeLanguage();
    return {
      hasError: true,
      message: error?.message || tLang(lang, 'errorBoundary.unknownRuntimeError'),
    };
  }

  private handleReset = () => {
    this.setState({ hasError: false, message: '' });
    this.props.onReset?.();
  };

  render() {
    if (this.state.hasError) {
      const lang = getActiveRuntimeLanguage();
      if (this.props.onReset) {
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 text-slate-100">
            <div className="max-w-md w-full rounded-xl border border-rose-500/35 bg-[#10161f] p-6 shadow-2xl">
              <h2 className="text-base font-bold tracking-wide text-amber-400">
                {this.props.sectionName
                  ? tLang(lang, 'errorBoundary.sectionRecoveryTitle', {
                      section: this.props.sectionName,
                    })
                  : tLang(lang, 'errorBoundary.panelRecoveryTitle')}
              </h2>
              <p className="mt-2 text-xs text-slate-300">{this.state.message}</p>
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={this.handleReset}
                  className="inline-flex items-center justify-center rounded-lg bg-amber-500 px-3.5 py-1.5 text-xs font-semibold text-slate-950 hover:bg-amber-400 transition-colors cursor-pointer"
                >
                  {tLang(lang, 'errorBoundary.closeAndReturn')}
                </button>
              </div>
            </div>
          </div>
        );
      }

      return (
        <div className="fixed inset-0 flex items-center justify-center bg-[#090d11] p-6 text-slate-100">
          <div className="max-w-md w-full rounded-xl border border-white/15 bg-[#10161f] p-6 shadow-2xl">
            <h1 className="text-lg font-bold tracking-wide text-amber-400">
              {tLang(lang, 'errorBoundary.rootRecoveryTitle')}
            </h1>
            <p className="mt-2 text-sm text-slate-300">{this.state.message}</p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-5 inline-flex items-center justify-center rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-amber-400 transition-colors cursor-pointer"
            >
              {tLang(lang, 'errorBoundary.reloadGame')}
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
